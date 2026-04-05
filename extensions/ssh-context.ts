/**
 * SSH parity extension (layers 0 & 1).
 *
 * Replicates pi's local resource loading on the remote machine over SSH:
 *   Layer 0 — SYSTEM.md + APPEND_SYSTEM.md
 *   Layer 1 — AGENTS.md / CLAUDE.md walk-up + skills
 *
 * No-ops when --ssh is not active (pi handles it natively).
 */

import type { ExtensionApi } from "@mariozechner/pi-coding-agent";
import { sshExec, sshFs } from "../src/fs-ops.js";
import { readSshFlag, resolveSshState, type SshState } from "../src/ssh.js";
import {
  collectAncestorSkillDirs,
  formatSkillsBlock,
  loadProjectContextFiles,
  loadRemoteSkills,
  mergeSkills,
  readFileFromDir,
} from "../src/loader.js";

export default function (pi: ExtensionApi) {
  const sshFlag = readSshFlag();
  let sshState: SshState | null = null;
  const sshStateReady = sshFlag
    ? resolveSshState(sshFlag).then((s) => { sshState = s; })
    : Promise.resolve();

  pi.on("before_agent_start", async (event: { systemPrompt: string }) => {
    await sshStateReady;
    if (!sshState) return; // local: pi handles natively

    const fs = sshFs(sshState.remote);
    const cwd = sshState.remoteCwd;
    const agentDir = (await sshExec(sshState.remote, "echo ~/.pi/agent")).trim();

    let systemPrompt = event.systemPrompt;
    let appendPrompt = "";

    // Layer 0: SYSTEM.md + APPEND_SYSTEM.md
    const remoteConfigDir = fs.join(cwd, ".pi");
    const systemMd =
      await readFileFromDir(fs, remoteConfigDir, "SYSTEM.md") ??
      await readFileFromDir(fs, agentDir, "SYSTEM.md");
    if (systemMd) systemPrompt = systemMd;

    const appendMd =
      await readFileFromDir(fs, remoteConfigDir, "APPEND_SYSTEM.md") ??
      await readFileFromDir(fs, agentDir, "APPEND_SYSTEM.md");
    if (appendMd) appendPrompt = appendMd;

    // Layer 1: AGENTS.md / CLAUDE.md walk-up + skills
    const contextFiles = await loadProjectContextFiles(fs, cwd, agentDir);
    if (contextFiles.length > 0) {
      const projectContext = contextFiles
        .map(f => `## ${f.path}\n\n${f.content}`)
        .join("\n\n");
      systemPrompt = `${systemPrompt}\n\n# Project Context\n\n${projectContext}`;
    }

    // Skills — mirrors pi's four locations:
    //   global:  ~/.pi/agent/skills/  and  ~/.agents/skills/
    //   project: <cwd>/.pi/skills/    and  <cwd>/.agents/skills/ (walk up to git root)
    const gitRoot = (await sshExec(sshState.remote, "git rev-parse --show-toplevel 2>/dev/null || true").catch(() => "")).trim() || null;
    const agentsGlobalSkillsDir = (await sshExec(sshState.remote, "echo ~/.agents/skills")).trim();

    const skillBatches = await Promise.all([
      loadRemoteSkills(fs, fs.join(agentDir, "skills")),
      loadRemoteSkills(fs, agentsGlobalSkillsDir),
      loadRemoteSkills(fs, fs.join(cwd, ".pi", "skills")),
      ...collectAncestorSkillDirs(fs, cwd, gitRoot).map(dir => loadRemoteSkills(fs, dir)),
    ]);

    const skills = mergeSkills(...skillBatches);
    if (skills.length > 0) {
      systemPrompt = `${systemPrompt}${formatSkillsBlock(skills)}`;
    }

    return {
      systemPrompt: [systemPrompt, appendPrompt].filter(Boolean).join("\n\n"),
    };
  });
}
