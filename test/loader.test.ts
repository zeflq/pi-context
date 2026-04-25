import { describe, it, expect } from "vitest";
import type { FsOps } from "../src/fs-ops.js";
import {
  findAgentsDir,
  findRootFile,
  collectConfigDirFiles,
  collectAncestorSkillDirs,
  mergeSkills,
  loadRemoteSkills,
} from "../src/loader.js";

// — Mock FsOps builder —

function makeFsOps(files: Record<string, string>): FsOps {
  const join = (...parts: string[]) =>
    parts.join("/").replace(/\/+/g, "/").replace(/\/$/, "") || "/";
  const dirname = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

  return {
    join,
    dirname,
    async exists(p) { return p in files || Object.keys(files).some(k => k.startsWith(p + "/")); },
    async read(p) { return files[p] ?? null; },
    async list(dir) {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      const seen = new Set<string>();
      for (const k of Object.keys(files)) {
        if (k.startsWith(prefix)) {
          const rest = k.slice(prefix.length);
          seen.add(rest.split("/")[0]);
        }
      }
      return [...seen];
    },
  };
}

// — findAgentsDir —

describe("findAgentsDir", () => {
  it("finds .pi when agents.md is present", async () => {
    const fs = makeFsOps({ "/project/.pi/agents.md": "# root" });
    expect(await findAgentsDir(fs, "/project")).toBe("/project/.pi");
  });

  it("finds .claude when .pi is absent", async () => {
    const fs = makeFsOps({ "/project/.claude/agents.md": "# root" });
    expect(await findAgentsDir(fs, "/project")).toBe("/project/.claude");
  });

  it("finds .agents as last fallback", async () => {
    const fs = makeFsOps({ "/project/.agents/agents.md": "# root" });
    expect(await findAgentsDir(fs, "/project")).toBe("/project/.agents");
  });

  it("prefers .pi over .claude when both exist", async () => {
    const fs = makeFsOps({
      "/project/.pi/agents.md": "# pi",
      "/project/.claude/agents.md": "# claude",
    });
    expect(await findAgentsDir(fs, "/project")).toBe("/project/.pi");
  });

  it("returns null when no config dir has agents.md", async () => {
    const fs = makeFsOps({ "/project/.pi/other.md": "# other" });
    expect(await findAgentsDir(fs, "/project")).toBeNull();
  });

  it("returns null when no config dir exists", async () => {
    const fs = makeFsOps({});
    expect(await findAgentsDir(fs, "/project")).toBeNull();
  });

  it("is case-insensitive for agents.md", async () => {
    const fs = makeFsOps({ "/project/.pi/AGENTS.MD": "# upper" });
    expect(await findAgentsDir(fs, "/project")).toBe("/project/.pi");
  });
});

// — collectConfigDirFiles —

describe("collectConfigDirFiles", () => {
  it("collects .md files with descriptions from .pi/", async () => {
    const fs = makeFsOps({
      "/project/.pi/review.md": "---\ndescription: Review playbook.\n---\n# Review",
      "/project/.pi/deploy.md": "---\ndescription: Deployment runbook.\n---\n# Deploy",
    });
    const visited = new Set(["/project/AGENTS.md"]);
    const result = await collectConfigDirFiles(fs, "/project", visited);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.filePath)).toContain("/project/.pi/review.md");
    expect(result.map(r => r.filePath)).toContain("/project/.pi/deploy.md");
    expect(result[0].content).toBeNull(); // stub only
  });

  it("skips files without a description field", async () => {
    const fs = makeFsOps({
      "/project/.pi/nodesc.md": "# No frontmatter",
      "/project/.pi/withdesc.md": "---\ndescription: Has one.\n---\n# Content",
    });
    const visited = new Set<string>();
    const result = await collectConfigDirFiles(fs, "/project", visited);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("/project/.pi/withdesc.md");
  });

  it("skips files already in visited set", async () => {
    const fs = makeFsOps({
      "/project/.pi/review.md": "---\ndescription: Review.\n---\n",
    });
    const visited = new Set(["/project/.pi/review.md"]);
    const result = await collectConfigDirFiles(fs, "/project", visited);
    expect(result).toHaveLength(0);
  });

  it("scans .claude/ and .agents/ as well", async () => {
    const fs = makeFsOps({
      "/project/.claude/style.md": "---\ndescription: Style guide.\n---\n",
      "/project/.agents/ops.md": "---\ndescription: Ops guide.\n---\n",
    });
    const visited = new Set<string>();
    const result = await collectConfigDirFiles(fs, "/project", visited);
    expect(result.map(r => r.filePath)).toContain("/project/.claude/style.md");
    expect(result.map(r => r.filePath)).toContain("/project/.agents/ops.md");
  });

  it("returns empty array when config dirs are absent", async () => {
    const fs = makeFsOps({});
    const visited = new Set<string>();
    const result = await collectConfigDirFiles(fs, "/project", visited);
    expect(result).toHaveLength(0);
  });

  it("is case-insensitive for .md extension", async () => {
    const fs = makeFsOps({
      "/project/.pi/README.MD": "---\ndescription: Upper ext.\n---\n",
    });
    const visited = new Set<string>();
    const result = await collectConfigDirFiles(fs, "/project", visited);
    expect(result).toHaveLength(1);
  });

  it("skips the skills/ subdirectory", async () => {
    const fs = makeFsOps({
      "/project/.pi/skills/deploy/SKILL.md": "---\ndescription: Deploy skill.\n---\n",
      "/project/.pi/notes.md": "---\ndescription: Project notes.\n---\n",
    });
    const visited = new Set<string>();
    const result = await collectConfigDirFiles(fs, "/project", visited);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("/project/.pi/notes.md");
  });

  it("recurses into subdirectories", async () => {
    const fs = makeFsOps({
      "/project/.pi/subdir/nested.md": "---\ndescription: Nested doc.\n---\n",
    });
    const visited = new Set<string>();
    const result = await collectConfigDirFiles(fs, "/project", visited);
    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe("/project/.pi/subdir/nested.md");
  });

  it("adds discovered files to visited to avoid duplicates across callers", async () => {
    const fs = makeFsOps({
      "/project/.pi/review.md": "---\ndescription: Review.\n---\n",
    });
    const visited = new Set<string>();
    await collectConfigDirFiles(fs, "/project", visited);
    expect(visited.has("/project/.pi/review.md")).toBe(true);
  });
});

// — collectAncestorSkillDirs —

describe("collectAncestorSkillDirs", () => {
  const fs = makeFsOps({});

  it("includes cwd/.agents/skills when gitRoot is null", async () => {
    const dirs = collectAncestorSkillDirs(fs, "/a/b/c", null);
    expect(dirs).toContain("/a/b/c/.agents/skills");
    expect(dirs).toContain("/a/b/.agents/skills");
    expect(dirs).toContain("/a/.agents/skills");
  });

  it("stops at gitRoot (inclusive)", async () => {
    const dirs = collectAncestorSkillDirs(fs, "/a/b/c", "/a/b");
    expect(dirs).toContain("/a/b/c/.agents/skills");
    expect(dirs).toContain("/a/b/.agents/skills");
    expect(dirs).not.toContain("/a/.agents/skills");
  });

  it("returns single entry when cwd equals gitRoot", async () => {
    const dirs = collectAncestorSkillDirs(fs, "/a/b", "/a/b");
    expect(dirs).toEqual(["/a/b/.agents/skills"]);
  });
});

// — mergeSkills —

describe("mergeSkills", () => {
  it("merges multiple batches", () => {
    const a = [{ name: "git", description: "Git skill", filePath: "/a/git/SKILL.md", content: "" }];
    const b = [{ name: "deploy", description: "Deploy skill", filePath: "/b/deploy/SKILL.md", content: "" }];
    expect(mergeSkills(a, b)).toHaveLength(2);
  });

  it("first batch wins on name collision", () => {
    const a = [{ name: "git", description: "from a", filePath: "/a/SKILL.md", content: "" }];
    const b = [{ name: "git", description: "from b", filePath: "/b/SKILL.md", content: "" }];
    const result = mergeSkills(a, b);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe("from a");
  });

  it("handles empty batches", () => {
    expect(mergeSkills([], [])).toEqual([]);
  });
});

// — loadRemoteSkills —

describe("loadRemoteSkills", () => {
  it("loads a skill from a subdirectory SKILL.md", async () => {
    const fs = makeFsOps({
      "/skills/git-helper/SKILL.md": "---\nname: git-helper\ndescription: Git conventions.\n---\n# Git",
    });
    const skills = await loadRemoteSkills(fs, "/skills");
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("git-helper");
    expect(skills[0].description).toBe("Git conventions.");
  });

  it("returns empty array for non-existent dir", async () => {
    const fs = makeFsOps({});
    const skills = await loadRemoteSkills(fs, "/nonexistent");
    expect(skills).toEqual([]);
  });

  it("skips skills without description", async () => {
    const fs = makeFsOps({
      "/skills/bad/SKILL.md": "---\nname: bad\n---\n# No description",
    });
    const skills = await loadRemoteSkills(fs, "/skills");
    expect(skills).toEqual([]);
  });

  it("falls back to dir name when name frontmatter is missing", async () => {
    const fs = makeFsOps({
      "/skills/my-tool/SKILL.md": "---\ndescription: My tool.\n---\n# Tool",
    });
    const skills = await loadRemoteSkills(fs, "/skills");
    expect(skills[0].name).toBe("my-tool");
  });

  it("does not recurse when SKILL.md is at the dir root", async () => {
    const fs = makeFsOps({
      "/skills/SKILL.md": "---\nname: root-skill\ndescription: Root.\n---\n",
      "/skills/nested/SKILL.md": "---\nname: nested\ndescription: Nested.\n---\n",
    });
    // dir itself has SKILL.md → treat as skill root, don't recurse
    const skills = await loadRemoteSkills(fs, "/skills");
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("root-skill");
  });
});
