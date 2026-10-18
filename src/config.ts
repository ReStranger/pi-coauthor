/**
 * Configuration loading for pi-coauthor.
 *
 * Precedence, highest first:
 *
 * 1. environment overrides (`PI_COAUTHOR_*`) — operational, applied last
 * 2. project file `<cwd>/.pi/pi-coauthor.json` (only when the project is trusted)
 * 3. global file `<agent dir>/extensions/pi-coauthor.json`
 * 4. defaults
 *
 * Files are merged key by key, and the deprecated `includeCoAuthoredBy` alias
 * follows Claude Code's behaviour, including its precedence trap.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type {
	AttributionConfigFile,
	ConfigSource,
	EffectiveConfig,
	LoadedConfig,
} from "./types.ts";

/** pi's project configuration directory (mirrors `CONFIG_DIR_NAME` from pi). */
export const CONFIG_DIR_NAME = ".pi";
/** Name of both the global and the project configuration file. */
export const CONFIG_FILE_NAME = "pi-coauthor.json";

export const DEFAULT_COMMIT_TEMPLATE = "Co-Authored-By: pi.dev ({model}) <{email}>";

/** Verified address for the @pidotdev account on GitHub. */
export const PIDOTDEV_GITHUB_EMAIL = "pidotdev@proton.me";
/** Generic unlinked noreply address. */
export const GENERIC_NOREPLY_EMAIL = "noreply@pi.dev";
export const DEFAULT_PR_TEMPLATE = "🤖 Generated with pi (https://pi.dev)";

/** Environment variable pi itself uses to relocate the agent directory. */
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

const ENV_KEYS = {
	enabled: "PI_COAUTHOR_ENABLED",
	githubLink: "PI_COAUTHOR_GITHUB_LINK",
	githubEmail: "PI_COAUTHOR_GITHUB_EMAIL",
	commit: "PI_COAUTHOR_COMMIT",
	pr: "PI_COAUTHOR_PR",
	strict: "PI_COAUTHOR_STRICT",
	extra: "PI_COAUTHOR_EXTRA",
} as const;

const KNOWN_KEYS = new Set([
	"enabled",
	"githubLink",
	"githubEmail",
	"includeCoAuthoredBy",
	"attribution",
	"strict",
	"extra",
]);

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export interface ReadConfigResult {
	file: AttributionConfigFile | undefined;
	exists: boolean;
	error: string | undefined;
}

export interface LoadConfigOptions {
	/** Session working directory (project config lives under it). */
	cwd: string;
	/** Read `<cwd>/.pi/pi-coauthor.json`; pass `ctx.isProjectTrusted()`. */
	readProject?: boolean;
	env?: NodeJS.ProcessEnv | undefined;
}

/** Expand a leading `~` the way pi's own path helpers do. */
export function expandHome(path: string, home: string = homedir()): string {
	if (path === "~") return home;
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
	return path;
}

/** pi's agent directory: `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
export function getAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[ENV_AGENT_DIR];
	if (override) return expandHome(override);
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(getAgentDir(env), "extensions", CONFIG_FILE_NAME);
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/** Parse a boolean the way CLI/env consumers expect. Returns `undefined` when unparseable. */
export function parseBoolean(value: string): boolean | undefined {
	const normalized = value.trim().toLowerCase();
	if (TRUTHY.has(normalized)) return true;
	if (FALSY.has(normalized)) return false;
	return undefined;
}

/** Read and JSON-parse a config file, reporting rather than throwing. */
export function readConfigFile(path: string): ReadConfigResult {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return { file: undefined, exists: false, error: undefined };
		return { file: undefined, exists: true, error: `${path}: ${errorMessage(error)}` };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return { file: undefined, exists: true, error: `${path}: invalid JSON (${errorMessage(error)})` };
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { file: undefined, exists: true, error: `${path}: expected a JSON object` };
	}

	return { file: parsed as AttributionConfigFile, exists: true, error: undefined };
}

/** Write a config file, creating parent directories. Returns an error message on failure. */
export function writeConfigFile(path: string, file: AttributionConfigFile): string | undefined {
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
		return undefined;
	} catch (error) {
		return `${path}: ${errorMessage(error)}`;
	}
}

/** Merge every configuration layer into the effective configuration. */
export function loadConfig(options: LoadConfigOptions): LoadedConfig {
	const env = options.env ?? process.env;
	const warnings: string[] = [];
	const sources: ConfigSource[] = [];
	const merged: MergedConfig = {};

	const globalPath = globalConfigPath(env);
	applyFile(merged, readConfigFile(globalPath), globalPath, "global", sources, warnings);

	if (options.readProject) {
		const projectPath = projectConfigPath(options.cwd);
		applyFile(merged, readConfigFile(projectPath), projectPath, "project", sources, warnings);
	}

	const config = resolveMerged(merged, warnings);
	applyEnvOverrides(config, env, sources, warnings);

	return { config, sources, warnings };
}

interface MergedConfig {
	enabled?: boolean;
	githubLink?: boolean;
	githubEmail?: string;
	includeCoAuthoredBy?: boolean;
	commit?: string;
	pr?: string;
	strict?: boolean;
	extra?: string;
}

function applyFile(
	merged: MergedConfig,
	read: ReadConfigResult,
	path: string,
	scope: ConfigSource["scope"],
	sources: ConfigSource[],
	warnings: string[],
): void {
	if (read.error) {
		warnings.push(read.error);
		return;
	}
	const file = read.file;
	if (!file) return;
	sources.push({ scope, path });

	for (const key of Object.keys(file)) {
		if (!KNOWN_KEYS.has(key)) warnings.push(`${path}: unknown key "${key}" ignored`);
	}

	if (file.enabled !== undefined) {
		if (typeof file.enabled === "boolean") merged.enabled = file.enabled;
		else warnings.push(`${path}: "enabled" must be a boolean`);
	}

	if (file.githubLink !== undefined) {
		if (typeof file.githubLink === "boolean") merged.githubLink = file.githubLink;
		else warnings.push(`${path}: "githubLink" must be a boolean`);
	}

	if (file.githubEmail !== undefined) {
		if (typeof file.githubEmail === "string") merged.githubEmail = file.githubEmail.trim();
		else warnings.push(`${path}: "githubEmail" must be a string`);
	}

	if (file.includeCoAuthoredBy !== undefined) {
		if (typeof file.includeCoAuthoredBy === "boolean") merged.includeCoAuthoredBy = file.includeCoAuthoredBy;
		else warnings.push(`${path}: "includeCoAuthoredBy" must be a boolean`);
	}

	if (file.attribution === false) {
		merged.commit = "";
		merged.pr = "";
	} else if (file.attribution !== undefined) {
		if (typeof file.attribution !== "object" || Array.isArray(file.attribution)) {
			warnings.push(`${path}: "attribution" must be an object or false`);
		} else {
			const { commit, pr, ...rest } = file.attribution;
			for (const key of Object.keys(rest)) {
				warnings.push(`${path}: unknown key "attribution.${key}" ignored`);
			}
			if (commit !== undefined) {
				if (typeof commit === "string") merged.commit = commit;
				else warnings.push(`${path}: "attribution.commit" must be a string`);
			}
			if (pr !== undefined) {
				if (typeof pr === "string") merged.pr = pr;
				else warnings.push(`${path}: "attribution.pr" must be a string`);
			}
		}
	}

	if (file.strict !== undefined) {
		if (typeof file.strict === "boolean") merged.strict = file.strict;
		else warnings.push(`${path}: "strict" must be a boolean`);
	}

	if (file.extra !== undefined) {
		if (typeof file.extra === "string") merged.extra = file.extra;
		else warnings.push(`${path}: "extra" must be a string`);
	}
}

/**
 * Apply defaults and the deprecated `includeCoAuthoredBy` alias.
 *
 * The alias is honoured only while neither `attribution.commit` nor
 * `attribution.pr` is set — Claude Code's documented (and surprising)
 * precedence, reproduced on purpose.
 */
function resolveMerged(merged: MergedConfig, warnings: string[]): EffectiveConfig {
	const attributionChanged = merged.commit !== undefined || merged.pr !== undefined;

	if (attributionChanged && merged.includeCoAuthoredBy !== undefined) {
		warnings.push(
			'"includeCoAuthoredBy" is ignored because "attribution.commit" or "attribution.pr" is set; ' +
				'the unset key falls back to its default. Set both "commit" and "pr" to "" to hide everything.',
		);
	}

	const disabledByAlias = !attributionChanged && merged.includeCoAuthoredBy === false;

	return {
		enabled: merged.enabled ?? true,
		githubLink: merged.githubLink ?? true,
		githubEmail: (merged.githubEmail && merged.githubEmail.trim()) || PIDOTDEV_GITHUB_EMAIL,
		commit: disabledByAlias ? "" : (merged.commit ?? DEFAULT_COMMIT_TEMPLATE),
		pr: disabledByAlias ? "" : (merged.pr ?? DEFAULT_PR_TEMPLATE),
		strict: merged.strict ?? false,
		extra: merged.extra ?? "",
	};
}

/** Environment overrides win over every file and never trigger the deprecated-key trap. */
function applyEnvOverrides(
	config: EffectiveConfig,
	env: NodeJS.ProcessEnv,
	sources: ConfigSource[],
	warnings: string[],
): void {
	let touched = false;

	const applyBoolean = (name: string, assign: (value: boolean) => void): void => {
		const raw = env[name];
		if (raw === undefined) return;
		touched = true;
		const parsed = parseBoolean(raw);
		if (parsed === undefined) warnings.push(`${name}: expected a boolean, got "${raw}"`);
		else assign(parsed);
	};

	const applyString = (name: string, assign: (value: string) => void): void => {
		const raw = env[name];
		if (raw === undefined) return;
		touched = true;
		assign(raw);
	};

	applyBoolean(ENV_KEYS.enabled, (value) => {
		config.enabled = value;
	});
	applyBoolean(ENV_KEYS.githubLink, (value) => {
		config.githubLink = value;
	});
	applyString(ENV_KEYS.githubEmail, (value) => {
		const trimmed = value.trim();
		if (trimmed) config.githubEmail = trimmed;
	});
	applyBoolean(ENV_KEYS.strict, (value) => {
		config.strict = value;
	});
	applyString(ENV_KEYS.commit, (value) => {
		config.commit = value;
	});
	applyString(ENV_KEYS.pr, (value) => {
		config.pr = value;
	});
	applyString(ENV_KEYS.extra, (value) => {
		config.extra = value;
	});

	if (touched) sources.push({ scope: "env", path: "PI_COAUTHOR_*" });
}

function isMissingFile(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error as { code?: unknown }).code === "ENOENT"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
