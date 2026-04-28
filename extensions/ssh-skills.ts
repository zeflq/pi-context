/**
 * SSH skills extension.
 *
 * Mirrors remote skill directories into a local temp folder so pi can load
 * them natively (debug panel, /skill:name commands). No-ops when --ssh is
 * not active.
 *
 * Also uploads local Windows global skills (~/.pi/agent/skills/) to a remote
 * temp dir so their sub-files (references/, assets/) are accessible in SSH mode.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join as localJoin } from "node:path";
import { join as posixJoin } from "node:path/posix";
import { sshExec } from "../src/fs-ops.js";
import { readSshFlag, resolveSshState, type SshState } from "../src/ssh.js";
import { mergeSkills } from "../src/loader.js";
import { parseFrontmatter } from "../src/markdown.js";

type Skill = { name: string; description: string; filePath: string; content: string };

/**
 * Finds SKILL.md files (and root .md files when allowRootMd is true) in a
 * remote directory using a single `find` invocation.
 */
async function findSkillFiles(remote: string, dir: string, allowRootMd: boolean): Promise<string[]> {
  const cmds = [`find ${JSON.stringify(dir)} -name "SKILL.md" -type f 2>/dev/null || true`];
  if (allowRootMd) {
    cmds.push(`find ${JSON.stringify(dir)} -maxdepth 1 -name "*.md" ! -name "SKILL.md" -type f 2>/dev/null || true`);
  }
  const out = await sshExec(remote, cmds.join("; ")).catch(() => "");
  return out.split("\n").map(l => l.trim()).filter(Boolean);
}

/**
 * Rewrites relative markdown links in SKILL.md content to absolute remote paths.
 * e.g. [guide](references/guide.md) → [guide](/remote/skill/dir/references/guide.md)
 * This ensures the agent reads sub-files from the remote machine via SSH.
 */
function absolutifySkillPaths(content: string, remoteSkillDir: string): string {
  return content.replace(
    /\[([^\]]*)\]\((?!https?:\/\/|\/|#)([^)]+)\)/g,
    (_, text, relPath) => `[${text}](${posixJoin(remoteSkillDir, relPath.trim())})`,
  );
}

/**
 * Returns all file paths relative to a local directory (recursive).
 */
function listLocalFiles(dir: string, base = dir): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = localJoin(dir, entry);
    if (statSync(full).isDirectory()) {
      result.push(...listLocalFiles(full, base));
    } else {
      result.push(full.slice(base.length + 1).replace(/\\/g, "/"));
    }
  }
  return result;
}

/**
 * Uploads a local text file to the remote machine via SSH using base64 encoding.
 */
async function uploadFileToRemote(remote: string, content: string, remotePath: string): Promise<void> {
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const remoteDir = remotePath.split("/").slice(0, -1).join("/");
  await sshExec(remote, `mkdir -p ${JSON.stringify(remoteDir)} && printf '%s' ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(remotePath)}`);
}

export default function (pi: ExtensionAPI) {
  const sshFlag = readSshFlag();
  let sshState: SshState | null = null;
  const sshStateReady = sshFlag
    ? resolveSshState(sshFlag).then((s) => { sshState = s; }).catch(() => { sshState = null; })
    : Promise.resolve();

  // Tracks the local temp dir for this session; refreshed on reload, deleted on exit.
  let skillsTempDir: string | null = null;
  // Tracks the remote temp dir for uploaded local global skills; deleted on exit.
  let remoteUploadDir: string | null = null;

  function cleanupLocal(): void {
    if (skillsTempDir) {
      try { rmSync(skillsTempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      skillsTempDir = null;
    }
  }

  async function cleanupRemote(): Promise<void> {
    if (remoteUploadDir && sshState) {
      await sshExec(sshState.remote, `rm -rf ${JSON.stringify(remoteUploadDir)}`).catch(() => {});
      remoteUploadDir = null;
    }
  }

  pi.on("resources_discover", async (_event, _ctx) => {
    await sshStateReady;
    if (!sshState) return;

    cleanupLocal(); // refresh on reload
    await cleanupRemote();

    const remote = sshState.remote;
    const cwd = sshState.remoteCwd.replace(/\/$/, "");

    const [agentDir, agentsGlobalSkillsDir] = await Promise.all([
      sshExec(remote, "echo ~/.pi/agent").then(s => s.trim()),
      sshExec(remote, "echo ~/.agents/skills").then(s => s.trim()),
    ]);

    // One find per skills dir, all in parallel.
    const skillDirs: Array<[string, boolean]> = [
      [posixJoin(agentDir, "skills"), true],
      [agentsGlobalSkillsDir, false],
      [posixJoin(cwd, ".pi", "skills"), true],
      [posixJoin(cwd, ".claude", "skills"), false],
      [posixJoin(cwd, ".agents", "skills"), false],
    ];
    const perDirPaths = await Promise.all(
      skillDirs.map(([dir, allowRootMd]) => findSkillFiles(remote, dir, allowRootMd))
    );

    // Read all discovered remote skill files in parallel (dedup paths first).
    const uniquePaths = [...new Set(perDirPaths.flat())];
    const rawByPath = new Map(
      (await Promise.all(
        uniquePaths.map(async p =>
          [p, await sshExec(remote, `cat ${JSON.stringify(p)}`).catch(() => null)] as const
        )
      )).filter((entry): entry is [string, string] => entry[1] !== null)
    );

    // Parse remote skills per dir to preserve priority order for mergeSkills.
    const remoteBatches = perDirPaths.map(paths =>
      paths.flatMap((filePath): Skill[] => {
        const raw = rawByPath.get(filePath);
        if (!raw) return [];
        const { fromMatter } = parseFrontmatter(raw);
        const description = fromMatter["description"]?.trim();
        if (!description) return [];
        const name = fromMatter["name"] || filePath.split("/").slice(-2, -1)[0] || "unknown";
        return [{ name, description, filePath, content: raw }];
      })
    );

    // Collect local Windows global skills and upload their sub-files to remote
    // so the agent can read them via SSH. Remote skills take priority (first wins).
    const localGlobalSkillsDir = localJoin(homedir(), ".pi", "agent", "skills");
    const localBatch: Skill[] = [];
    if (existsSync(localGlobalSkillsDir)) {
      const uploadBase = `/tmp/pi-global-skills-${Date.now()}`;
      remoteUploadDir = uploadBase;

      for (const entry of readdirSync(localGlobalSkillsDir)) {
        const localSkillDir = localJoin(localGlobalSkillsDir, entry);
        if (!statSync(localSkillDir).isDirectory()) continue;
        const localSkillMd = localJoin(localSkillDir, "SKILL.md");
        if (!existsSync(localSkillMd)) continue;

        const raw = readFileSync(localSkillMd, "utf8");
        const { fromMatter } = parseFrontmatter(raw);
        const description = fromMatter["description"]?.trim();
        if (!description) continue;

        const name = fromMatter["name"] || entry;
        const remoteSkillDir = posixJoin(uploadBase, entry);

        // Upload all sub-files (not SKILL.md) to remote.
        const subFiles = listLocalFiles(localSkillDir).filter(f => f !== "SKILL.md");
        await Promise.all(subFiles.map(async (relPath) => {
          try {
            const content = readFileSync(localJoin(localSkillDir, ...relPath.split("/")), "utf8");
            await uploadFileToRemote(remote, content, posixJoin(remoteSkillDir, relPath));
          } catch { /* skip unreadable / binary files */ }
        }));

        localBatch.push({ name, description, filePath: localJoin(localSkillDir, "SKILL.md"), content: raw });
      }
    }

    // Remote skills have priority; local Windows skills fill in what's missing.
    const skills = mergeSkills(...remoteBatches, localBatch);
    if (skills.length === 0) return;

    const tempDir = mkdtempSync(localJoin(tmpdir(), "pi-remote-skills-"));
    skillsTempDir = tempDir;

    for (const skill of skills) {
      const isLocal = skill.filePath.includes(localJoin(homedir(), ".pi", "agent", "skills"));
      const remoteSkillDir = isLocal
        ? posixJoin(remoteUploadDir!, skill.name)
        : skill.filePath.split("/").slice(0, -1).join("/");

      const localSkillDir = localJoin(tempDir, skill.name);
      mkdirSync(localSkillDir, { recursive: true });
      writeFileSync(
        localJoin(localSkillDir, "SKILL.md"),
        absolutifySkillPaths(skill.content, remoteSkillDir),
        "utf8",
      );
    }

    return { skillPaths: [tempDir] };
  });

  pi.on("session_shutdown", async () => {
    cleanupLocal();
    await cleanupRemote();
  });
}
