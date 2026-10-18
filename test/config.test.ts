import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	DEFAULT_COMMIT_TEMPLATE,
	DEFAULT_PR_TEMPLATE,
	PIDOTDEV_GITHUB_EMAIL,
	globalConfigPath,
	loadConfig,
	projectConfigPath,
} from "../src/config.ts";
import type { AttributionConfigFile } from "../src/types.ts";

const created: string[] = [];

afterEach(() => {
	while (created.length > 0) {
		const path = created.pop();
		if (path) rmSync(path, { recursive: true, force: true });
	}
});

interface Fixture {
	cwd: string;
	env: Record<string, string>;
}

function makeFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "pi-coauthor-config-"));
	created.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	return { cwd, env: { PI_CODING_AGENT_DIR: agentDir } };
}

function writeJson(path: string, value: AttributionConfigFile): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("loadConfig", () => {
	it("falls back to the defaults when no config file exists", () => {
		const { cwd, env } = makeFixture();

		const loaded = loadConfig({ cwd, env });

		expect(loaded.config).toEqual({
			enabled: true,
			githubLink: true,
			githubEmail: PIDOTDEV_GITHUB_EMAIL,
			commit: DEFAULT_COMMIT_TEMPLATE,
			pr: DEFAULT_PR_TEMPLATE,
			strict: false,
			extra: "",
		});
		expect(loaded.sources).toEqual([]);
		expect(loaded.warnings).toEqual([]);
	});

	it("reads the global file next to the agent directory", () => {
		const { cwd, env } = makeFixture();
		const path = globalConfigPath(env);
		writeJson(path, { attribution: { commit: "Co-Authored-By: Someone <a@b.c>" } });

		const loaded = loadConfig({ cwd, env });

		expect(loaded.config.commit).toBe("Co-Authored-By: Someone <a@b.c>");
		expect(loaded.config.pr).toBe(DEFAULT_PR_TEMPLATE);
		expect(loaded.sources).toEqual([{ scope: "global", path }]);
	});

	it("merges the project file key by key", () => {
		const { cwd, env } = makeFixture();
		writeJson(globalConfigPath(env), { attribution: { commit: "global-commit" }, strict: true });
		writeJson(projectConfigPath(cwd), { attribution: { pr: "project-pr" } });

		const loaded = loadConfig({ cwd, env, readProject: true });

		expect(loaded.config.commit).toBe("global-commit");
		expect(loaded.config.pr).toBe("project-pr");
		expect(loaded.config.strict).toBe(true);
		expect(loaded.sources.map((source) => source.scope)).toEqual(["global", "project"]);
	});

	it("ignores the project file unless the project is trusted", () => {
		const { cwd, env } = makeFixture();
		writeJson(projectConfigPath(cwd), { attribution: { commit: "project-commit" } });

		expect(loadConfig({ cwd, env }).config.commit).toBe(DEFAULT_COMMIT_TEMPLATE);
		expect(loadConfig({ cwd, env, readProject: true }).config.commit).toBe("project-commit");
	});

	it("treats attribution: false as hiding every surface", () => {
		const { cwd, env } = makeFixture();
		writeJson(globalConfigPath(env), { attribution: false });

		const loaded = loadConfig({ cwd, env });

		expect(loaded.config.commit).toBe("");
		expect(loaded.config.pr).toBe("");
	});

	it("honours the deprecated includeCoAuthoredBy alias", () => {
		const { cwd, env } = makeFixture();
		writeJson(globalConfigPath(env), { includeCoAuthoredBy: false });

		const loaded = loadConfig({ cwd, env });

		expect(loaded.config.commit).toBe("");
		expect(loaded.config.pr).toBe("");
		expect(loaded.warnings).toEqual([]);
	});

	it("reproduces Claude Code's precedence trap and warns about it", () => {
		const { cwd, env } = makeFixture();
		writeJson(globalConfigPath(env), {
			includeCoAuthoredBy: false,
			attribution: { commit: "custom" },
		});

		const loaded = loadConfig({ cwd, env });

		expect(loaded.config.commit).toBe("custom");
		expect(loaded.config.pr).toBe(DEFAULT_PR_TEMPLATE);
		expect(loaded.warnings).toHaveLength(1);
		expect(loaded.warnings[0]).toContain("includeCoAuthoredBy");
	});

	it("lets environment overrides win without triggering the trap", () => {
		const { cwd, env } = makeFixture();
		writeJson(globalConfigPath(env), { includeCoAuthoredBy: false });

		const loaded = loadConfig({
			cwd,
			env: { ...env, PI_COAUTHOR_COMMIT: "from-env", PI_COAUTHOR_STRICT: "yes" },
		});

		expect(loaded.config.commit).toBe("from-env");
		expect(loaded.config.pr).toBe("");
		expect(loaded.config.strict).toBe(true);
		expect(loaded.warnings).toEqual([]);
		expect(loaded.sources.at(-1)).toEqual({ scope: "env", path: "PI_COAUTHOR_*" });
	});

	it("reports wrong types and unknown keys without failing", () => {
		const { cwd, env } = makeFixture();
		mkdirSync(dirname(globalConfigPath(env)), { recursive: true });
		writeFileSync(
			globalConfigPath(env),
			JSON.stringify({ enabled: "yes", nope: 1, attribution: { commit: 42, other: true } }),
			"utf8",
		);

		const loaded = loadConfig({ cwd, env });

		expect(loaded.config.enabled).toBe(true);
		expect(loaded.config.commit).toBe(DEFAULT_COMMIT_TEMPLATE);
		expect(loaded.warnings).toEqual([
			`${globalConfigPath(env)}: unknown key "nope" ignored`,
			`${globalConfigPath(env)}: "enabled" must be a boolean`,
			`${globalConfigPath(env)}: unknown key "attribution.other" ignored`,
			`${globalConfigPath(env)}: "attribution.commit" must be a string`,
		]);
	});

	it("survives invalid JSON", () => {
		const { cwd, env } = makeFixture();
		mkdirSync(dirname(globalConfigPath(env)), { recursive: true });
		writeFileSync(globalConfigPath(env), "{ not json", "utf8");

		const loaded = loadConfig({ cwd, env });

		expect(loaded.config.commit).toBe(DEFAULT_COMMIT_TEMPLATE);
		expect(loaded.warnings[0]).toContain("invalid JSON");
	});

	it("merges githubLink from files and respects PI_COAUTHOR_GITHUB_LINK", () => {
		const { cwd, env } = makeFixture();
		writeJson(globalConfigPath(env), { githubLink: false });

		expect(loadConfig({ cwd, env }).config.githubLink).toBe(false);

		writeJson(projectConfigPath(cwd), { githubLink: true });
		expect(loadConfig({ cwd, env, readProject: true }).config.githubLink).toBe(true);

		const overridden = loadConfig({
			cwd,
			env: { ...env, PI_COAUTHOR_GITHUB_LINK: "false" },
			readProject: true,
		});
		expect(overridden.config.githubLink).toBe(false);
	});

	it("merges githubEmail and respects PI_COAUTHOR_GITHUB_EMAIL", () => {
		const { cwd, env } = makeFixture();
		writeJson(projectConfigPath(cwd), { githubEmail: "custom@example.com" });

		expect(loadConfig({ cwd, env, readProject: true }).config.githubEmail).toBe("custom@example.com");

		const overridden = loadConfig({
			cwd,
			env: { ...env, PI_COAUTHOR_GITHUB_EMAIL: "override@example.com" },
			readProject: true,
		});
		expect(overridden.config.githubEmail).toBe("override@example.com");
	});

	it("rejects an unparseable boolean in the environment", () => {
		const { cwd, env } = makeFixture();

		const loaded = loadConfig({ cwd, env: { ...env, PI_COAUTHOR_ENABLED: "maybe" } });

		expect(loaded.config.enabled).toBe(true);
		expect(loaded.warnings).toEqual(['PI_COAUTHOR_ENABLED: expected a boolean, got "maybe"']);
	});
});
