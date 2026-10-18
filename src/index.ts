/**
 * pi-coauthor — Claude Code-style commit and pull-request attribution for pi.
 *
 * Prompt-only by design: the extension appends an attribution block to the
 * system prompt before every agent run and never rewrites commands, so the
 * behaviour matches Claude Code's built-in git instructions, softened by the
 * same trade-off (the model may ignore them).
 */

import { basename } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { resolveAttribution } from "./attribution.ts";
import {
	DEFAULT_COMMIT_TEMPLATE,
	DEFAULT_PR_TEMPLATE,
	globalConfigPath,
	loadConfig,
	parseBoolean,
	projectConfigPath,
	readConfigFile,
	writeConfigFile,
} from "./config.ts";
import { appendBlock, buildBlock } from "./instructions.ts";
import type {
	AttributionConfigFile,
	FactSources,
	GitInfo,
	GitInfoProvider,
	LoadedConfig,
	ResolvedAttribution,
} from "./types.ts";

const OFF_FLAG = "coauthor-off";
const PREVIEW_WIDGET = "pi-coauthor-preview";

const COMPLETIONS = [
	{ value: "status", label: "status", description: "Show effective settings and their sources" },
	{ value: "preview", label: "preview", description: "Show the block injected into the system prompt" },
	{ value: "hide", label: "hide", description: "Clear the preview widget" },
	{ value: "on", label: "on", description: "Enable attribution in this project" },
	{ value: "off", label: "off", description: "Disable attribution in this project" },
	{ value: "set", label: "set", description: "set <commit|pr|strict|enabled|githubLink|githubEmail|extra> <value> [--global]" },
	{ value: "reset", label: "reset", description: "reset <key> [--global]" },
	{ value: "help", label: "help", description: "Show usage" },
];

type SettingKey =
	| "commit"
	| "pr"
	| "strict"
	| "enabled"
	| "githubLink"
	| "githubEmail"
	| "extra";

const SETTING_KEYS: readonly SettingKey[] = [
	"commit",
	"pr",
	"strict",
	"enabled",
	"githubLink",
	"githubEmail",
	"extra",
];

export default function piCoauthor(pi: ExtensionAPI): void {
	const gitCache = new Map<string, Promise<GitInfo>>();
	const notified = new Set<string>();

	pi.on("session_start", () => {
		gitCache.clear();
		notified.clear();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (pi.getFlag(OFF_FLAG) === true) return;

		const loaded = loadConfig({ cwd: ctx.cwd, readProject: ctx.isProjectTrusted() });
		notifyWarnings(ctx, notified, loaded.warnings);
		if (!loaded.config.enabled) return;

		const resolved = await resolveAttribution(
			loaded.config,
			factSources(ctx, gitProvider(pi, gitCache, ctx.cwd)),
		);
		notifyWarnings(ctx, notified, resolved.warnings);

		const block = buildBlock(resolved, loaded.config);
		const next = appendBlock(event.systemPrompt, block);
		if (next === event.systemPrompt) return;
		return { systemPrompt: next };
	});

	pi.registerFlag(OFF_FLAG, {
		type: "boolean",
		default: false,
		description: "Disable pi-coauthor attribution for this run",
	});

	pi.registerCommand("coauthor", {
		description: "Show or edit pi-coauthor commit and PR attribution",
		getArgumentCompletions: (prefix) => COMPLETIONS.filter((item) => item.value.startsWith(prefix)),
		handler: async (args, ctx) => {
			const [subcommand = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);

			switch (subcommand) {
				case "status":
					await showStatus(pi, ctx, gitCache);
					return;
				case "preview":
					await showPreview(pi, ctx, gitCache);
					return;
				case "hide":
					ctx.ui.setWidget(PREVIEW_WIDGET, undefined);
					ctx.ui.notify("pi-coauthor: preview cleared", "info");
					return;
				case "on":
				case "off":
					await writeSetting(ctx, "enabled", subcommand === "on", false);
					return;
				case "set":
					await handleSet(ctx, rest);
					return;
				case "reset":
					await handleReset(ctx, rest);
					return;
				case "help":
					showHelp(ctx);
					return;
				default:
					ctx.ui.notify(`pi-coauthor: unknown subcommand "${subcommand}" — try /coauthor help`, "warning");
			}
		},
	});
}

async function showStatus(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	gitCache: Map<string, Promise<GitInfo>>,
): Promise<void> {
	const { loaded, resolved } = await readEverything(pi, ctx, gitCache);
	const { config } = loaded;
	const offByFlag = pi.getFlag(OFF_FLAG) === true;

	const lines = [
		`pi-coauthor: ${config.enabled ? "enabled" : "disabled"}${offByFlag ? " (--coauthor-off for this run)" : ""}`,
		`model label: ${resolved.modelLabel}`,
		`commit: ${config.commit ? resolved.commitTrailer : "off"}`,
		`pr: ${config.pr ? resolved.prLine : "off"}`,
		`strict: ${config.strict}`,
		`githubLink: ${config.githubLink ? "on" : "off (unlinked noreply@pi.dev)"}`,
		`githubEmail: ${config.githubEmail}`,
		`resolved email: ${resolved.facts.email}`,
		"sources:",
		...(loaded.sources.length > 0
			? loaded.sources.map((source) => `  ${source.scope}: ${source.path}`)
			: ["  no config files found, defaults in use"]),
	];

	ctx.ui.notify(lines.join("\n"), "info");
}

async function showPreview(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	gitCache: Map<string, Promise<GitInfo>>,
): Promise<void> {
	const { loaded, resolved } = await readEverything(pi, ctx, gitCache);
	const block = buildBlock(resolved, loaded.config);

	if (!block) {
		ctx.ui.notify("pi-coauthor: nothing to inject — every attribution surface is off", "info");
		return;
	}

	if (!ctx.hasUI) {
		ctx.ui.notify(block, "info");
		return;
	}

	ctx.ui.setWidget(PREVIEW_WIDGET, block.split("\n"));
	ctx.ui.notify("pi-coauthor: preview shown above the editor — /coauthor hide clears it", "info");
}

async function handleSet(ctx: ExtensionCommandContext, args: string[]): Promise<void> {
	const global = args.includes("--global");
	const [key, ...valueParts] = args.filter((part) => part !== "--global");

	if (!isSettingKey(key)) {
		ctx.ui.notify(`pi-coauthor: expected one of ${SETTING_KEYS.join(", ")}, got "${key ?? ""}"`, "warning");
		return;
	}

	const raw = valueParts.join(" ");
	let value: string | boolean;
	if (key === "strict" || key === "enabled" || key === "githubLink") {
		const parsed = parseBoolean(raw);
		if (parsed === undefined) {
			ctx.ui.notify(`pi-coauthor: "${raw}" is not a boolean (use true/false, on/off, 1/0)`, "warning");
			return;
		}
		value = parsed;
	} else {
		value = stripQuotes(raw);
	}

	await writeSetting(ctx, key, value, global);
}

async function handleReset(ctx: ExtensionCommandContext, args: string[]): Promise<void> {
	const global = args.includes("--global");
	const [key] = args.filter((part) => part !== "--global");

	if (!isSettingKey(key)) {
		ctx.ui.notify(`pi-coauthor: expected one of ${SETTING_KEYS.join(", ")}, got "${key ?? ""}"`, "warning");
		return;
	}

	await writeSetting(ctx, key, undefined, global);
}

async function writeSetting(
	ctx: ExtensionCommandContext,
	key: SettingKey,
	value: string | boolean | undefined,
	global: boolean,
): Promise<void> {
	if (!global && !ctx.isProjectTrusted()) {
		ctx.ui.notify(
			"pi-coauthor: this project is not trusted, so a project config would be ignored. " +
				"Re-run with --global or approve the project.",
			"warning",
		);
		return;
	}

	const path = global ? globalConfigPath() : projectConfigPath(ctx.cwd);
	const current = readConfigFile(path);
	if (current.error) {
		ctx.ui.notify(`pi-coauthor: ${current.error}`, "error");
		return;
	}

	const next = applySetting(current.file ?? {}, key, value);
	if ("error" in next) {
		ctx.ui.notify(`pi-coauthor: ${next.error}`, "warning");
		return;
	}

	if (ctx.hasUI) {
		const verb = value === undefined ? "Remove" : "Set";
		const shown = value === undefined ? `${key}` : `${key} = ${JSON.stringify(value)}`;
		const confirmed = await ctx.ui.confirm(
			"pi-coauthor",
			`${verb} ${shown} in ${path}?`,
		);
		if (!confirmed) return;
	}

	const error = writeConfigFile(path, next.file);
	if (error) {
		ctx.ui.notify(`pi-coauthor: ${error}`, "error");
		return;
	}

	ctx.ui.notify(
		value === undefined
			? `pi-coauthor: ${key} removed from ${path}`
			: `pi-coauthor: ${key} written to ${path}`,
		"info",
	);
}

function showHelp(ctx: ExtensionCommandContext): void {
	ctx.ui.notify(
		[
			"pi-coauthor — Claude Code-style attribution for pi",
			"",
			"/coauthor status              effective settings and where they come from",
			"/coauthor preview             the block injected into the system prompt",
			"/coauthor hide                clear the preview widget",
			"/coauthor on | off            enable or disable attribution for this project",
			"/coauthor set <key> <value>   commit | pr | strict | enabled | githubLink | githubEmail | extra",
			"/coauthor reset <key>         drop a key and inherit the value below",
			"add --global to set/reset the user-level config instead",
			"",
			`default commit template: ${DEFAULT_COMMIT_TEMPLATE}`,
			`default pr template: ${DEFAULT_PR_TEMPLATE}`,
			"placeholders: {model} {modelId} {provider} {session} {sessionFile} {cwd} {repo} {branch} {date} {host} {email}",
			"note: GitHub links co-authors strictly by email. Set githubEmail to change the account, or githubLink false to commit without a GitHub account link.",
		].join("\n"),
		"info",
	);
}

interface SettingResult {
	file: AttributionConfigFile;
}

interface SettingFailure {
	error: string;
}

function applySetting(
	file: AttributionConfigFile,
	key: SettingKey,
	value: string | boolean | undefined,
): SettingResult | SettingFailure {
	const next: AttributionConfigFile = { ...file };

	if (key === "commit" || key === "pr") {
		if (value !== undefined && typeof value !== "string") {
			return { error: `"${key}" expects a string` };
		}
		const attribution = typeof next.attribution === "object" && next.attribution !== null ? { ...next.attribution } : {};
		if (value === undefined) delete attribution[key];
		else attribution[key] = value;

		if (Object.keys(attribution).length === 0) delete next.attribution;
		else next.attribution = attribution;
		return { file: next };
	}

	if (value === undefined) {
		delete next[key];
		return { file: next };
	}

	if (key === "strict" || key === "enabled" || key === "githubLink") {
		if (typeof value !== "boolean") return { error: `"${key}" expects a boolean` };
		next[key] = value;
		return { file: next };
	}

	if (key === "githubEmail") {
		if (typeof value !== "string" || !value.trim()) {
			return { error: `"${key}" expects a non-empty email string` };
		}
		next.githubEmail = value.trim();
		return { file: next };
	}

	if (typeof value !== "string") return { error: `"${key}" expects a string` };
	next.extra = value;
	return { file: next };
}

function isSettingKey(value: string | undefined): value is SettingKey {
	return value !== undefined && (SETTING_KEYS as readonly string[]).includes(value);
}

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed.at(-1);
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) return trimmed.slice(1, -1);
	}
	return trimmed;
}

async function readEverything(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	gitCache: Map<string, Promise<GitInfo>>,
): Promise<{ loaded: LoadedConfig; resolved: ResolvedAttribution }> {
	const loaded = loadConfig({ cwd: ctx.cwd, readProject: ctx.isProjectTrusted() });
	const resolved = await resolveAttribution(
		loaded.config,
		factSources(ctx, gitProvider(pi, gitCache, ctx.cwd)),
	);
	return { loaded, resolved };
}

function factSources(ctx: ExtensionContext, git: GitInfoProvider): FactSources {
	return {
		model: ctx.model
			? { id: ctx.model.id, name: ctx.model.name, provider: String(ctx.model.provider) }
			: undefined,
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile() ?? "",
		cwd: ctx.cwd,
		git,
	};
}

function gitProvider(
	pi: ExtensionAPI,
	cache: Map<string, Promise<GitInfo>>,
	cwd: string,
): GitInfoProvider {
	return () => {
		let pending = cache.get(cwd);
		if (!pending) {
			pending = readGitInfo(pi, cwd);
			cache.set(cwd, pending);
		}
		return pending;
	};
}

async function readGitInfo(pi: ExtensionAPI, cwd: string): Promise<GitInfo> {
	try {
		const [root, head] = await Promise.all([
			pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd }),
			pi.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd }),
		]);
		const topLevel = root.code === 0 ? root.stdout.trim() : "";
		const branch = head.code === 0 ? head.stdout.trim() : "";
		return {
			repo: topLevel ? basename(topLevel) : "",
			branch: branch === "HEAD" ? "" : branch,
		};
	} catch {
		return { repo: "", branch: "" };
	}
}

function notifyWarnings(ctx: ExtensionContext, notified: Set<string>, warnings: readonly string[]): void {
	if (!ctx.hasUI) return;
	for (const warning of warnings) {
		if (notified.has(warning)) continue;
		notified.add(warning);
		ctx.ui.notify(`pi-coauthor: ${warning}`, "warning");
	}
}
