/**
 * Template resolution for pi-coauthor.
 *
 * The model label and every placeholder are resolved on the extension side, so
 * the injected system-prompt block always contains ready-to-use literals — the
 * same trick Claude Code uses when it bakes the trailer text into the Bash tool
 * description.
 */

import { hostname as osHostname } from "node:os";
import { basename } from "node:path";

import { GENERIC_NOREPLY_EMAIL, PIDOTDEV_GITHUB_EMAIL } from "./config.ts";
import type {
	EffectiveConfig,
	FactSources,
	ModelLike,
	PlaceholderFacts,
	ResolvedAttribution,
} from "./types.ts";

const PLACEHOLDER_PATTERN = /\{\{|\}\}|\{([a-zA-Z0-9_]+)\}/g;
const PLAIN_NUMBER = /^\d+(?:\.\d+)*$/;
const DATE_STAMP = /^\d{8}$/;

/** Model ids are often all-caps-able tokens; keep the common ones readable. */
const ACRONYMS = new Map<string, string>([
	["gpt", "GPT"],
	["ai", "AI"],
	["llm", "LLM"],
	["mcp", "MCP"],
	["api", "API"],
	["oss", "OSS"],
	["vl", "VL"],
]);

const ALL_PLACEHOLDERS: readonly (keyof PlaceholderFacts)[] = [
	"model",
	"modelId",
	"provider",
	"session",
	"sessionFile",
	"cwd",
	"repo",
	"branch",
	"date",
	"host",
	"email",
];

/** Placeholder names a template actually uses, de-duplicated and in first-seen order. */
export function parsePlaceholders(template: string): string[] {
	const names: string[] = [];
	for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
		const name = match[1];
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

/**
 * Render `{placeholder}` values into a template.
 * `{{` / `}}` are literal braces; unknown placeholders are left untouched and reported.
 */
export function renderTemplate(
	template: string,
	facts: Partial<PlaceholderFacts>,
): { text: string; unknown: string[] } {
	const unknown: string[] = [];
	const text = template.replace(PLACEHOLDER_PATTERN, (match: string, name?: string) => {
		if (match === "{{") return "{";
		if (match === "}}") return "}";
		if (!name) return match;
		const value = (facts as Record<string, string | undefined>)[name];
		if (value === undefined) {
			if (!unknown.includes(name)) unknown.push(name);
			return match;
		}
		return value;
	});
	return { text, unknown };
}

/** Turn a model id such as `claude-sonnet-4-5-20250929` into `Claude Sonnet 4.5`. */
export function humanizeModelId(id: string, provider?: string): string {
	const trimmed = id.trim();
	if (!trimmed) return "";

	const tokens = trimmed.split(/[/\-_.:]+/).filter(Boolean);
	const withoutProvider =
		provider && tokens[0]?.toLowerCase() === provider.toLowerCase() ? tokens.slice(1) : tokens;

	const words: string[] = [];
	for (const token of withoutProvider) {
		if (DATE_STAMP.test(token)) continue;

		const acronym = ACRONYMS.get(token.toLowerCase());
		if (acronym) {
			words.push(acronym);
			continue;
		}

		if (PLAIN_NUMBER.test(token)) {
			const lastIndex = words.length - 1;
			const last = words.at(lastIndex);
			if (last && PLAIN_NUMBER.test(last)) words.splice(lastIndex, 1, `${last}.${token}`);
			else words.push(token);
			continue;
		}

		words.push(token.charAt(0).toUpperCase() + token.slice(1));
	}

	return words.join(" ");
}

/**
 * Human-readable model name for the `{model}` placeholder.
 * Falls back from the model's display name to a humanized id, then to `pi`.
 */
export function resolveModelLabel(model?: ModelLike | undefined): string {
	const name = model?.name?.trim();
	if (name) return name;

	const id = model?.id?.trim();
	if (id) {
		const humanized = humanizeModelId(id, model?.provider);
		if (humanized) return humanized;
	}

	return "pi";
}

/** Local-time `YYYY-MM-DD`. */
export function formatDate(now: Date): string {
	const month = `${now.getMonth() + 1}`.padStart(2, "0");
	const day = `${now.getDate()}`.padStart(2, "0");
	return `${now.getFullYear()}-${month}-${day}`;
}

/** Placeholder names used by the effective configuration. */
export function collectUsedPlaceholders(config: EffectiveConfig): string[] {
	const names = new Set<string>();
	for (const template of [config.commit, config.pr]) {
		for (const name of parsePlaceholders(template)) names.add(name);
	}
	return [...names];
}

/** Build every placeholder value, running the git lookup only when a template needs it. */
export async function collectFacts(
	sources: FactSources,
	used: readonly string[],
): Promise<{ facts: PlaceholderFacts; warnings: string[] }> {
	const warnings: string[] = [];
	const needed = new Set(used);

	let repo = basename(sources.cwd) || sources.cwd;
	let branch = "";

	if (needed.has("repo") || needed.has("branch")) {
		if (sources.git) {
			try {
				const info = await sources.git();
				if (info.repo) repo = info.repo;
				branch = info.branch;
			} catch (error) {
				warnings.push(
					`git lookup failed (${error instanceof Error ? error.message : String(error)}); ` +
						'using the working directory name for "{repo}"',
				);
			}
		} else {
			warnings.push('"{repo}"/"{branch}" need a git lookup, which is unavailable in this context');
		}
	}

	const facts: PlaceholderFacts = {
		model: resolveModelLabel(sources.model),
		modelId: sources.model?.id ?? "unknown",
		provider: sources.model?.provider ?? "unknown",
		session: sources.sessionId ?? "unknown",
		sessionFile: sources.sessionFile ?? "",
		cwd: sources.cwd,
		repo,
		branch,
		date: formatDate(sources.now ?? new Date()),
		host: sources.hostname ?? osHostname(),
		email:
			sources.githubLink !== false
				? (sources.githubEmail?.trim() || PIDOTDEV_GITHUB_EMAIL)
				: GENERIC_NOREPLY_EMAIL,
	};

	return { facts, warnings };
}

/** Resolve every attribution string for the current session. */
export async function resolveAttribution(
	config: EffectiveConfig,
	sources: FactSources,
): Promise<ResolvedAttribution> {
	const warnings: string[] = [];
	const used = collectUsedPlaceholders(config);
	const sourcesWithConfig: FactSources = {
		...sources,
		githubLink: sources.githubLink ?? config.githubLink,
		githubEmail: sources.githubEmail ?? config.githubEmail,
	};
	const { facts, warnings: factWarnings } = await collectFacts(sourcesWithConfig, used);
	warnings.push(...factWarnings);

	const render = (template: string, trimAll: boolean): string => {
		if (!template) return "";
		const { text, unknown } = renderTemplate(template, facts);
		for (const name of unknown) warnings.push(`unknown placeholder {${name}} left as-is`);
		const blank = trimAll ? text.trim() : text.replace(/\s+$/, "");
		if (!blank && template.trim()) warnings.push("template resolved to an empty string");
		return blank;
	};

	return {
		commitTrailer: render(config.commit, false),
		prLine: render(config.pr, true),
		modelLabel: facts.model,
		facts,
		warnings,
	};
}

/** Exported for `/coauthor status`: every placeholder name, for help text. */
export const PLACEHOLDER_NAMES: readonly string[] = ALL_PLACEHOLDERS;
