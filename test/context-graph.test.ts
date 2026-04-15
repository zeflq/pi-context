import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contextGraph, { extractContextPathsFromSystemPrompt } from "../extensions/context-graph.js";

type BeforeAgentStartHandler = (event: { systemPrompt: string }, ctx: { cwd: string }) => Promise<{ systemPrompt: string } | undefined>;

function createBeforeAgentStartHandler(): BeforeAgentStartHandler {
  const handlers: Record<string, BeforeAgentStartHandler> = {};
  const pi = {
    on(eventName: string, handler: BeforeAgentStartHandler) {
      handlers[eventName] = handler;
    },
  };

  contextGraph(pi as never);

  const handler = handlers["before_agent_start"];
  if (!handler) throw new Error("before_agent_start handler was not registered");
  return handler;
}

describe("extractContextPathsFromSystemPrompt", () => {
  it("extracts file paths from markdown headings", () => {
    const prompt = [
      "Base system",
      "",
      "# Project Context",
      "",
      "## /repo/AGENTS.md",
      "Root content",
      "",
      "## /repo/.pi/AGENTS.md",
      "Nested content",
    ].join("\n");

    const paths = extractContextPathsFromSystemPrompt(prompt);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toBe("/repo/AGENTS.md");
    expect(paths[1]).toBe("/repo/.pi/AGENTS.md");
  });

  it("ignores non-path headings", () => {
    const prompt = [
      "Base system",
      "",
      "## Overview",
      "Should not be parsed as a file",
      "",
      "## /repo/AGENTS.md",
      "Real file content",
    ].join("\n");

    const paths = extractContextPathsFromSystemPrompt(prompt);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toBe("/repo/AGENTS.md");
  });
});

describe("context-graph before_agent_start", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends on-demand linked stubs from root file content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-graph-"));
    tempDirs.push(dir);

    const rootPath = join(dir, "AGENTS.md");
    const linkedPath = join(dir, "deploy.md");

    writeFileSync(
      rootPath,
      [
        "# Root",
        "[Deployment](deploy.md)",
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      linkedPath,
      [
        "---",
        "description: Deployment runbook.",
        "---",
        "# Deploy",
      ].join("\n"),
      "utf8",
    );

    const handler = createBeforeAgentStartHandler();
    const result = await handler(
      {
        systemPrompt: [
          "Base system prompt",
          "",
          "# Project Context",
          "",
          `## ${rootPath}`,
          "[Deployment](deploy.md)",
        ].join("\n"),
      },
      { cwd: dir },
    );

    expect(result?.systemPrompt).toContain("<on-demand-files>");
    expect(result?.systemPrompt).toContain(linkedPath);
    expect(result?.systemPrompt).toContain("Deployment runbook.");
  });

  it("detects plain .md references from root context content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-graph-"));
    tempDirs.push(dir);

    const rootPath = join(dir, "AGENTS.md");
    const reviewPath = join(dir, ".pi", "REVIEW.md");

    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(rootPath, "## Review\nwhen making a review load -> .pi/REVIEW.md\n", "utf8");
    writeFileSync(
      reviewPath,
      [
        "---",
        "description: Review playbook.",
        "---",
        "# Review",
      ].join("\n"),
      "utf8",
    );

    const handler = createBeforeAgentStartHandler();
    const result = await handler(
      {
        systemPrompt: [
          "Base system prompt",
          "",
          "# Project Context",
          "",
          `## ${rootPath}`,
          "## Review",
          "when making a review load -> .pi/REVIEW.md",
        ].join("\n"),
      },
      { cwd: dir },
    );

    expect(result?.systemPrompt).toContain("<on-demand-files>");
    expect(result?.systemPrompt).toContain(reviewPath);
    expect(result?.systemPrompt).toContain("Review playbook.");
  });

  it("returns undefined when no path-based root files exist in system prompt", async () => {
    const handler = createBeforeAgentStartHandler();
    const result = await handler(
      {
        systemPrompt: [
          "Base system prompt",
          "",
          "## Overview",
          "No file path headings here",
        ].join("\n"),
      },
      { cwd: process.cwd() },
    );

    expect(result).toBeUndefined();
  });
});
