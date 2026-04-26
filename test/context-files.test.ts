import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contextFiles from "../extensions/context-files.js";

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

describe("context-files before_agent_start", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discovers .md files with descriptions from .pi/", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-files-"));
    tempDirs.push(dir);

    const piDir = join(dir, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "# Instructions", "utf8");
    writeFileSync(
      join(piDir, "review.md"),
      ["---", "description: Code review playbook.", "---", "# Review"].join("\n"),
      "utf8",
    );

    const handler = createBeforeAgentStartHandler();
    const result = await handler(
      { systemPrompt: "Base system prompt" },
      { cwd: dir },
    );

    expect(result?.systemPrompt).toContain("<context-files>");
    expect(result?.systemPrompt).toContain(join(piDir, "review.md"));
    expect(result?.systemPrompt).toContain("Code review playbook.");
  });

  it("skips config dir files without a description field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-files-"));
    tempDirs.push(dir);

    const piDir = join(dir, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "# Root", "utf8");
    writeFileSync(join(piDir, "nodesc.md"), "# No description frontmatter", "utf8");

    const handler = createBeforeAgentStartHandler();
    const result = await handler(
      { systemPrompt: "Base system prompt" },
      { cwd: dir },
    );

    expect(result).toBeUndefined();
  });

  it("returns undefined when no AGENTS.md found walking up from cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-files-empty-"));
    tempDirs.push(dir);

    const handler = createBeforeAgentStartHandler();
    const result = await handler(
      { systemPrompt: "Base system prompt" },
      { cwd: dir },
    );

    expect(result).toBeUndefined();
  });

  it("scans .claude/ and .agents/ config dirs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-files-"));
    tempDirs.push(dir);

    mkdirSync(join(dir, ".claude"), { recursive: true });
    mkdirSync(join(dir, ".agents"), { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "# Root", "utf8");
    writeFileSync(
      join(dir, ".claude", "style.md"),
      ["---", "description: Code style guide.", "---"].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(dir, ".agents", "deploy.md"),
      ["---", "description: Deploy runbook.", "---"].join("\n"),
      "utf8",
    );

    const handler = createBeforeAgentStartHandler();
    const result = await handler(
      { systemPrompt: "Base system prompt" },
      { cwd: dir },
    );

    expect(result?.systemPrompt).toContain("Code style guide.");
    expect(result?.systemPrompt).toContain("Deploy runbook.");
  });

  it("recursively discovers files in subdirectories", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-files-"));
    tempDirs.push(dir);

    const subDir = join(dir, ".pi", "architecture");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "# Root", "utf8");
    writeFileSync(
      join(subDir, "overview.md"),
      ["---", "description: Architecture overview.", "---"].join("\n"),
      "utf8",
    );

    const handler = createBeforeAgentStartHandler();
    const result = await handler(
      { systemPrompt: "Base system prompt" },
      { cwd: dir },
    );

    expect(result?.systemPrompt).toContain("Architecture overview.");
  });

  it("skips files in skills/ subdirectory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-files-"));
    tempDirs.push(dir);

    const skillsDir = join(dir, ".pi", "skills", "my-skill");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(dir, "AGENTS.md"), "# Root", "utf8");
    writeFileSync(
      join(skillsDir, "SKILL.md"),
      ["---", "description: A skill.", "---"].join("\n"),
      "utf8",
    );

    const handler = createBeforeAgentStartHandler();
    const result = await handler(
      { systemPrompt: "Base system prompt" },
      { cwd: dir },
    );

    expect(result).toBeUndefined();
  });

  it("uses AGENTS.md in .pi/ as project root correctly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-context-files-"));
    tempDirs.push(dir);

    const piDir = join(dir, ".pi");
    mkdirSync(piDir, { recursive: true });
    writeFileSync(join(piDir, "AGENTS.md"), "# Root", "utf8");
    writeFileSync(
      join(piDir, "review.md"),
      ["---", "description: Review guide.", "---"].join("\n"),
      "utf8",
    );

    const handler = createBeforeAgentStartHandler();
    const result = await handler(
      { systemPrompt: "Base system prompt" },
      { cwd: dir },
    );

    expect(result?.systemPrompt).toContain("Review guide.");
  });
});
