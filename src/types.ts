/**
 * Configuration and value types for pi-coauthor.
 *
 * pi-coauthor mirrors Claude Code's attribution settings — a commit trailer, a
 * pull-request line, and the deprecated boolean alias — and resolves them from
 * JSON config files and environment variables.
 */

/**
 * A config file. Every key is optional: files are merged key by key, so a
 * project file can override `pr` while `commit` keeps the global value.
 */
export interface AttributionConfigFile {
	/** Master switch. `false` disables the extension without deleting the config. */
	enabled?: boolean;
	/**
	 * When `true` (default), `{email}` resolves to `githubEmail` (defaults to
	 * `pidotdev@proton.me`) so GitHub attributes commits
	 * to a GitHub user profile. When `false`, `{email}` resolves to `noreply@pi.dev`
	 * without linking to a GitHub user profile.
	 */
	githubLink?: boolean;
	/**
	 * Custom GitHub noreply or verified email address for `{email}` when `githubLink`
	 * is enabled. Defaults to `pidotdev@proton.me`.
	 */
	githubEmail?: string;
	/**
	 * Deprecated Claude Code alias. `false` hides both the commit trailer and the
	 * pull-request line, but is ignored as soon as `attribution.commit` or
	 * `attribution.pr` is set anywhere — the same trap Claude Code has.
	 */
	includeCoAuthoredBy?: boolean;
	/** Attribution texts. `false` hides all of them, like Claude Code's `attribution: false`. */
	attribution?: Partial<AttributionSettings> | false;
	/**
	 * When `true`, the injected rules tell the model to keep the attribution even
	 * if other instructions ask it to drop it.
	 */
	strict?: boolean;
	/** Free-form text appended to the injected block. */
	extra?: string;
}

/** Attribution texts. An empty string disables that surface. */
export interface AttributionSettings {
	/**
	 * Template for the commit trailer. Placeholders: `{model}`, `{modelId}`,
	 * `{provider}`, `{session}`, `{sessionFile}`, `{cwd}`, `{repo}`, `{branch}`,
	 * `{date}`, `{host}`, `{email}`. Use `{{` and `}}` for literal braces.
	 */
	commit: string;
	/** Template for the pull-request body line. Same placeholders as `commit`. */
	pr: string;
}

/** Effective configuration after defaults, files, and environment overrides. */
export interface EffectiveConfig {
	enabled: boolean;
	githubLink: boolean;
	githubEmail: string;
	/** Commit trailer template; `""` when disabled. */
	commit: string;
	/** Pull-request line template; `""` when disabled. */
	pr: string;
	strict: boolean;
	extra: string;
}

/** Where a configuration value came from (shown by `/coauthor status`). */
export interface ConfigSource {
	scope: "global" | "project" | "env";
	path: string;
}

/** Result of merging every configuration layer. */
export interface LoadedConfig {
	config: EffectiveConfig;
	sources: ConfigSource[];
	/** Non-fatal problems: wrong types, unreadable files, the deprecated-key trap. */
	warnings: string[];
}

/** Structural subset of pi's `Model` that pi-coauthor needs. */
export interface ModelLike {
	id: string;
	name: string;
	provider: string;
}

export interface GitInfo {
	/** Directory name of the repository root; `""` when not in a repository. */
	repo: string;
	/** Current branch name; `""` for a detached HEAD. */
	branch: string;
}

/** Lazy, cached git lookup. Called only when a template uses `{repo}`/`{branch}`. */
export type GitInfoProvider = () => Promise<GitInfo>;

/** Values available to templates. */
export interface PlaceholderFacts {
	model: string;
	modelId: string;
	provider: string;
	session: string;
	sessionFile: string;
	cwd: string;
	repo: string;
	branch: string;
	date: string;
	host: string;
	email: string;
}

/** Everything the resolver needs; all fields are injectable for tests. */
export interface FactSources {
	model?: ModelLike | undefined;
	sessionId?: string | undefined;
	sessionFile?: string | undefined;
	cwd: string;
	now?: Date | undefined;
	hostname?: string | undefined;
	git?: GitInfoProvider | undefined;
	githubLink?: boolean | undefined;
	githubEmail?: string | undefined;
}

/** Ready-to-use attribution strings for the current session. */
export interface ResolvedAttribution {
	/** Resolved commit trailer; `""` when disabled. */
	commitTrailer: string;
	/** Resolved pull-request line; `""` when disabled. */
	prLine: string;
	/** Human-readable model name used for `{model}`. */
	modelLabel: string;
	facts: PlaceholderFacts;
	warnings: string[];
}
