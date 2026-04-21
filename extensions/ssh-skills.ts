/**
 * SSH skills extension.
 *
 * Mirrors remote skill directories into a local temp folder so pi can load
 * them natively (debug panel, /skill:name commands). No-ops when --ssh is
 * not active.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname as localDirname, join as localJoin } from "node:path";
import { dirname as posixDirname, join as posixJoin } from "node:path/posix";
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

export default function (pi: ExtensionAPI) {
  const sshFlag = readSshFlag();
  let sshState: SshState | null = null;
  const sshStateReady = sshFlag
    ? resolveSshState(sshFlag).then((s) => { sshState = s; })
    : Promise.resolve();

  // Recursively copies a remote directory to a local destination.
  // Uses `find -type f` to list all files, then reads each via SSH cat in parallel.
  async function copyRemoteDirToLocal(remote: string, remoteDir: string, localDir: string): Promise<void> {
    const out = await sshExec(remote, `find ${JSON.stringify(remoteDir)} -type f 2>/dev/null || true`).catch(() => "");
    const files = out.split("\n").map(l => l.trim()).filter(Boolean);
    await Promise.all(files.map(async remoteFile => {
      const rel = remoteFile.slice(remoteDir.length).replace(/^\//, "");
      const localFile = localJoin(localDir, ...rel.split("/"));
      const content = await sshExec(remote, `cat ${JSON.stringify(remoteFile)}`).catch(() => null);
      if (content === null) return;
      mkdirSync(localDirname(localFile), { recursive: true });
      writeFileSync(localFile, content, "utf8");
    }));
  }

  // Tracks the local temp dir for this session; refreshed on reload, deleted on exit.
  let skillsTempDir: string | null = null;
  function cleanupSkillsTempDir(): void {
    if (skillsTempDir) {
      try { rmSync(skillsTempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      skillsTempDir = null;
    }
  }

  pi.on("resources_discover", async (_event, _ctx) => {
    await sshStateReady;
    if (!sshState) return;

    cleanupSkillsTempDir(); // refresh on reload

    // For localhost pi discovers all skills natively (global and project) —
    // skip mirroring entirely to avoid skill-name conflicts.
    const isLocalhost = sshState.remote === "localhost" || sshState.remote === "127.0.0.1";
    if (isLocalhost) return;

    const remote = sshState.remote;
    const cwd = sshState.remoteCwd;

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

    // Read all discovered skill files in parallel (dedup paths first).
    const uniquePaths = [...new Set(perDirPaths.flat())];
    if (uniquePaths.length === 0) return;

    const rawByPath = new Map(
      (await Promise.all(
        uniquePaths.map(async p =>
          [p, await sshExec(remote, `cat ${JSON.stringify(p)}`).catch(() => null)] as const
        )
      )).filter((entry): entry is [string, string] => entry[1] !== null)
    );

    // Parse into skill objects per dir to preserve priority order for mergeSkills.
    const batches = perDirPaths.map(paths =>
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

    const skills = mergeSkills(...batches);
    if (skills.length === 0) return;

    // Copy each remote skill directory (including subfolders like references/)
    // into a local temp dir so pi's scanner resolves skills natively.
    const tempDir = mkdtempSync(localJoin(tmpdir(), "pi-remote-skills-"));
    skillsTempDir = tempDir;
    await Promise.all(skills.map(skill =>
      copyRemoteDirToLocal(
        remote,
        posixDirname(skill.filePath),      // e.g. /home/user/.pi/skills/my-skill
        localJoin(tempDir, skill.name),    // e.g. /tmp/pi-remote-skills-XYZ/my-skill
      )
    ));

    return { skillPaths: [tempDir] };
  });

  pi.on("session_shutdown", () => { cleanupSkillsTempDir(); });
}
