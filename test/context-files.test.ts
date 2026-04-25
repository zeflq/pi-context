import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contextFiles, { extractContextFilesFromSystemPrompt } from "../extensions/context-files.js";

type BeforeAgentStartHandler = (event: { systemPrompt: string }, ctx: { cwd: string }) => Promise<{ systemPrompt: string } | undefined>;

function createBeforeAgentStartHandler(): BeforeAgentStartHandler {
  const handlers: Record<string, BeforeAgentStartHandler> = {};
  const pi = {
    on(eventName: string, handler: BeforeAgentStartHandler) {
      handlers[eventName] = handler;
    },
  };

  contextFiles(pi as never);

  const handler = handlers["before_agent_start"];
  if (!handler) throw new Error("before_agent_start handler was not registered");
  return handler;
}


describe("extractContextFilesFromSystemPrompt", () => {
  it("extracts path and content from ## /path sections", () => {
    const prompt = [
      "Base system",
      "",
      "## /repo/AGENTS.md",
      "",
      "Some content here",
      "[link](file.md)",
      "",
      "## /repo/.pi/AGENTS.md",
      "Nested content",
    ].join("\n");
    const files = extractContextFilesFromSystemPrompt(prompt);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("/repo/AGENTS.md");
    expect(files[0].content).toContain("Some content here");
    expect(files[0].content).toContain("[link](file.md)");
    expect(files[1].path).toBe("/repo/.pi/AGENTS.md");
    expect(files[1].content).toBe("Nested content");
  });

  it("treats ## headings within content that are not file paths as content", () => {
    const prompt = [
      "## /repo/AGENTS.md",
      "",
      "## Overview",
      "Not a file path heading",
    ].join("\n");
    const files = extractContextFilesFromSystemPrompt(prompt);
    expect(files).toHaveLength(1);
    expect(files[0].content).toContain("## Overview");
    expect(files[0].content).toContain("Not a file path heading");
  });

  it("returns empty array when no file path headings found", () => {
    expect(extractContextFilesFromSystemPrompt("## Overview\nsome content")).toHaveLength(0);
  });

  it("handles Windows CRLF line endings", () => {
    const prompt = "## /repo/AGENTS.md\r\nsome content\r\n";
    const files = extractContextFilesFromSystemPrompt(prompt);
    expect(files).toHaveLength(1);
    expect(files[0].content).toBe("some content");
  });
});

describe("context-graph before_agent_start", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers .md files with descriptions from .pi/ without explicit links", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-graph-"));
    tempDirs.push(dir);

    const rootPath = join(dir, "AGENTS.md");
    const piDir = join(dir, ".pi");
    const reviewPath = join(piDir, "review.md");

    mkdirSync(piDir, { recursive: true });
    writeFileSync(rootPath, "# Instructions\nFollow the review process.", "utf8");
    writeFileSync(
      reviewPath,
      ["---", "description: Code review playbook.", "---", "# Review"].join("\n"),
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
          "# Instructions",
          "Follow the review process.",
        ].join("\n"),
      },
      { cwd: dir },
    );

    expect(result?.systemPrompt).toContain("<context-files>");
    expect(result?.systemPrompt).toContain(reviewPath);
    expect(result?.systemPrompt).toContain("Code review playbook.");
  });

  it("skips config dir files without a description field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-graph-"));
    tempDirs.push(dir);

    const rootPath = join(dir, "AGENTS.md");
    const piDir = join(dir, ".pi");

    mkdirSync(piDir, { recursive: true });
    writeFileSync(rootPath, "# Root", "utf8");
    writeFileSync(join(piDir, "nodesc.md"), "# No description frontmatter", "utf8");

    const handler = createBeforeAgentStartHandler();
    const result = await handler(
      {
        systemPrompt: [`## ${rootPath}`, "# Root"].join("\n"),
      },
      { cwd: dir },
    );

    expect(result).toBeUndefined();
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
