import { describe, expect, it, vi } from "vitest";

import {
	formatDate,
	humanizeModelId,
	parsePlaceholders,
	renderTemplate,
	resolveAttribution,
	resolveModelLabel,
} from "../src/attribution.ts";
import { DEFAULT_COMMIT_TEMPLATE, PIDOTDEV_GITHUB_EMAIL } from "../src/config.ts";
import type { EffectiveConfig, FactSources, GitInfo } from "../src/types.ts";

const BASE_CONFIG: EffectiveConfig = {
	enabled: true,
	githubLink: true,
	githubEmail: PIDOTDEV_GITHUB_EMAIL,
	commit: DEFAULT_COMMIT_TEMPLATE,
	pr: "🤖 Generated with pi (https://pi.dev)",
	strict: false,
	extra: "",
};

const BASE_SOURCES: FactSources = {
	model: { id: "claude-sonnet-4-5-20250929", name: "Claude Sonnet 5", provider: "anthropic" },
	sessionId: "0192f0aa-1234",
	sessionFile: "/home/u/.pi/agent/sessions/abc.jsonl",
	cwd: "/home/u/code/pi-coauthor",
	now: new Date("2026-03-04T10:11:12Z"),
	hostname: "workstation",
	git: async (): Promise<GitInfo> => ({ repo: "pi-coauthor", branch: "main" }),
};

describe("humanizeModelId", () => {
	it("turns versioned ids into readable labels", () => {
		expect(humanizeModelId("claude-sonnet-4-5-20250929", "anthropic")).toBe("Claude Sonnet 4.5");
		expect(humanizeModelId("claude-3-5-haiku")).toBe("Claude 3.5 Haiku");
		expect(humanizeModelId("gpt-5.1-codex")).toBe("GPT 5.1 Codex");
		expect(humanizeModelId("openai/gpt-4o", "openai")).toBe("GPT 4o");
		expect(humanizeModelId("", "anthropic")).toBe("");
	});
});

describe("resolveModelLabel", () => {
	it("prefers the display name", () => {
		expect(resolveModelLabel({ id: "x", name: "Claude Sonnet 5", provider: "anthropic" })).toBe(
			"Claude Sonnet 5",
		);
	});

	it("falls back to a humanized id", () => {
		expect(resolveModelLabel({ id: "gpt-5.1-codex", name: "", provider: "openai" })).toBe("GPT 5.1 Codex");
	});

	it("falls back to pi when the model is unknown", () => {
		expect(resolveModelLabel(undefined)).toBe("pi");
		expect(resolveModelLabel({ id: "", name: "", provider: "" })).toBe("pi");
	});
});

describe("renderTemplate", () => {
	it("replaces known placeholders and reports unknown ones", () => {
		const { text, unknown } = renderTemplate("{model} in {repo}", { model: "pi", repo: "demo" });
		expect(text).toBe("pi in demo");
		expect(unknown).toEqual([]);

		const missing = renderTemplate("{nope} {model}", { model: "pi" });
		expect(missing.text).toBe("{nope} pi");
		expect(missing.unknown).toEqual(["nope"]);
	});

	it("treats doubled braces as literals", () => {
		expect(renderTemplate("{{model}}", { model: "pi" }).text).toBe("{model}");
	});

	it("parses placeholder names once, in order", () => {
		expect(parsePlaceholders("{repo} {branch} {repo}")).toEqual(["repo", "branch"]);
	});
});

describe("formatDate", () => {
	it("formats a padded local date", () => {
		expect(formatDate(new Date(2026, 2, 4))).toBe("2026-03-04");
	});
});

describe("resolveAttribution", () => {
	it("resolves the default templates for a session", async () => {
		const resolved = await resolveAttribution(BASE_CONFIG, BASE_SOURCES);

		expect(resolved.commitTrailer).toBe(
			"Co-Authored-By: pi.dev (Claude Sonnet 5) <pidotdev@proton.me>",
		);
		expect(resolved.facts.email).toBe("pidotdev@proton.me");
		expect(resolved.prLine).toBe("🤖 Generated with pi (https://pi.dev)");
		expect(resolved.modelLabel).toBe("Claude Sonnet 5");
		expect(resolved.facts.session).toBe("0192f0aa-1234");
		expect(resolved.facts.date).toBe("2026-03-04");
		expect(resolved.facts.host).toBe("workstation");
		expect(resolved.warnings).toEqual([]);
	});

	it("does not run the git lookup when no template needs it", async () => {
		const git = vi.fn(async (): Promise<GitInfo> => ({ repo: "unused", branch: "unused" }));

		await resolveAttribution(BASE_CONFIG, { ...BASE_SOURCES, git });

		expect(git).not.toHaveBeenCalled();
	});

	it("resolves git placeholders lazily", async () => {
		const resolved = await resolveAttribution(
			{ ...BASE_CONFIG, commit: "{repo}@{branch}" },
			BASE_SOURCES,
		);

		expect(resolved.commitTrailer).toBe("pi-coauthor@main");
	});

	it("falls back to the directory name when git fails", async () => {
		const resolved = await resolveAttribution(
			{ ...BASE_CONFIG, commit: "{repo}" },
			{
				...BASE_SOURCES,
				git: async () => {
					throw new Error("not a git repository");
				},
			},
		);

		expect(resolved.commitTrailer).toBe("pi-coauthor");
		expect(resolved.warnings[0]).toContain("git lookup failed");
	});

	it("returns empty strings for disabled surfaces", async () => {
		const resolved = await resolveAttribution({ ...BASE_CONFIG, commit: "", pr: "" }, BASE_SOURCES);

		expect(resolved.commitTrailer).toBe("");
		expect(resolved.prLine).toBe("");
	});

	it("warns about unknown placeholders", async () => {
		const resolved = await resolveAttribution({ ...BASE_CONFIG, commit: "{nope}" }, BASE_SOURCES);

		expect(resolved.commitTrailer).toBe("{nope}");
		expect(resolved.warnings).toContain("unknown placeholder {nope} left as-is");
	});

	it("resolves {email} based on the githubLink setting", async () => {
		const linked = await resolveAttribution(
			{ ...BASE_CONFIG, githubLink: true, commit: "Email: <{email}>" },
			BASE_SOURCES,
		);
		expect(linked.commitTrailer).toBe("Email: <pidotdev@proton.me>");
		expect(linked.facts.email).toBe("pidotdev@proton.me");

		const unlinked = await resolveAttribution(
			{ ...BASE_CONFIG, githubLink: false, commit: "Email: <{email}>" },
			BASE_SOURCES,
		);
		expect(unlinked.commitTrailer).toBe("Email: <noreply@pi.dev>");
		expect(unlinked.facts.email).toBe("noreply@pi.dev");
	});

	it("uses custom githubEmail when provided", async () => {
		const custom = await resolveAttribution(
			{
				...BASE_CONFIG,
				githubLink: true,
				githubEmail: "custom@example.com",
				commit: "Email: <{email}>",
			},
			BASE_SOURCES,
		);
		expect(custom.commitTrailer).toBe("Email: <custom@example.com>");
		expect(custom.facts.email).toBe("custom@example.com");
	});
});
