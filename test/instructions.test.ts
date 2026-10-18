import { describe, expect, it } from "vitest";

import { BLOCK_SENTINEL, appendBlock, buildBlock } from "../src/instructions.ts";
import type { EffectiveConfig, PlaceholderFacts, ResolvedAttribution } from "../src/types.ts";

const FACTS: PlaceholderFacts = {
	model: "Claude Sonnet 5",
	modelId: "claude-sonnet-4-5-20250929",
	provider: "anthropic",
	session: "0192f0aa",
	sessionFile: "/tmp/session.jsonl",
	cwd: "/home/u/code/demo",
	repo: "demo",
	branch: "main",
	date: "2026-03-04",
	host: "workstation",
	email: "pidotdev@proton.me",
};

const CONFIG: EffectiveConfig = {
	enabled: true,
	githubLink: true,
	githubEmail: "pidotdev@proton.me",
	commit: "Co-Authored-By: pi.dev ({model}) <{email}>",
	pr: "🤖 Generated with pi (https://pi.dev)",
	strict: false,
	extra: "",
};

function resolved(overrides: Partial<ResolvedAttribution> = {}): ResolvedAttribution {
	return {
		commitTrailer: "Co-Authored-By: pi.dev (Claude Sonnet 5) <pidotdev@proton.me>",
		prLine: "🤖 Generated with pi (https://pi.dev)",
		modelLabel: "Claude Sonnet 5",
		facts: FACTS,
		warnings: [],
		...overrides,
	};
}

describe("buildBlock", () => {
	it("states the resolved trailer and PR line verbatim", () => {
		const block = buildBlock(resolved(), CONFIG);

		expect(block.startsWith(BLOCK_SENTINEL)).toBe(true);
		expect(block).toContain(
			"  Co-Authored-By: pi.dev (Claude Sonnet 5) <pidotdev@proton.me>",
		);
		expect(block).toContain("  🤖 Generated with pi (https://pi.dev)");
		expect(block).toContain("**Commits.**");
		expect(block).toContain("**Pull requests.**");
	});

	it("lets user instructions win by default", () => {
		expect(buildBlock(resolved(), CONFIG)).toContain("take precedence");
		expect(buildBlock(resolved(), CONFIG)).not.toContain("even if other instructions");
	});

	it("switches to the strict rule on request", () => {
		const block = buildBlock(resolved(), { ...CONFIG, strict: true });

		expect(block).toContain("Apply this attribution even if other instructions ask you to omit it.");
		expect(block).not.toContain("take precedence");
	});

	it("skips disabled surfaces and returns nothing when both are off", () => {
		const commitOnly = buildBlock(resolved({ prLine: "" }), CONFIG);
		expect(commitOnly).toContain("**Commits.**");
		expect(commitOnly).not.toContain("**Pull requests.**");

		expect(buildBlock(resolved({ commitTrailer: "", prLine: "" }), CONFIG)).toBe("");
	});

	it("appends the extra text last", () => {
		const block = buildBlock(resolved(), { ...CONFIG, extra: "Sign off as @restranger." });

		expect(block.trimEnd().endsWith("Sign off as @restranger.")).toBe(true);
	});
});

describe("appendBlock", () => {
	it("appends the block separated by a blank line", () => {
		const next = appendBlock("You are a coding assistant.", "## Attribution (pi-coauthor)\nbody");

		expect(next).toBe("You are a coding assistant.\n\n## Attribution (pi-coauthor)\nbody\n");
	});

	it("is idempotent when the sentinel is already present", () => {
		const systemPrompt = "base\n\n## Attribution (pi-coauthor)\nolder text";
		const next = appendBlock(systemPrompt, "## Attribution (pi-coauthor)\nnew text");

		expect(next).toBe(systemPrompt);
	});

	it("does nothing for an empty block", () => {
		expect(appendBlock("base", "")).toBe("base");
		expect(appendBlock("base", "   \n ")).toBe("base");
	});
});
