/**
 * Context file auto-discovery extension (layer 2).
 *
 * Walks up from cwd (local or remote) to find AGENTS.md / CLAUDE.md files,
 * then scans their project's config dirs (.pi/, .claude/, .agents/) for .md
 * files with a `description` frontmatter field, and injects a <context-files>
 * block so the agent can load them on demand via the read tool.
 *
 * Works both locally and over SSH.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { localFs, sshFs } from "../src/fs-ops.js";
import { readSshFlag, resolveSshState, type SshState } from "../src/ssh.js";
import { formatContextFilesBlock, collectConfigDirFiles, walkUpContextFiles, CONFIG_DIR_NAMES, type LoadedFile } from "../src/loader.js";

export default function (pi: ExtensionAPI) {
  const sshFlag = readSshFlag();
  let sshState: SshState | null = null;
  let sshStateError: string | null = null;

  const sshStateReady: Promise<void> = sshFlag
    ? resolveSshState(sshFlag)
      .then((s) => { sshState = s; })
      .catch((err) => { sshStateError = err instanceof Error ? err.message : String(err); })
    : Promise.resolve();

  pi.on("before_agent_start", async (event, ctx) => {
    await sshStateReady;

    if (sshFlag && !sshState) {
      // SSH was requested but state resolution failed — surface the error.
      if (sshStateError) {
        return {
          systemPrompt: `${event.systemPrompt}\n\n> [context-files] Failed to resolve SSH target: ${sshStateError}`,
        };
      }
      return;
    }

    const fs = sshState ? sshFs(sshState.remote) : localFs;
    const cwd = sshState ? sshState.remoteCwd : ctx.cwd;

    const rootFiles = await walkUpContextFiles(fs, cwd);
    if (rootFiles.length === 0) return;

    const visited = new Set(rootFiles.map((f) => f.path));

    // If AGENTS.md lives inside a config dir (e.g. /project/.pi/AGENTS.md),
    // use the parent as the project root so we scan /project/.pi/ correctly.
    // If it lives directly in the project root (e.g. /project/AGENTS.md),
    // use that directory as-is.
    const projectRoot = (dir: string) => {
      const base = dir.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
      return CONFIG_DIR_NAMES.includes(base) ? fs.dirname(dir) : dir;
    };

    const linked: LoadedFile[] = (
      await Promise.all(
        rootFiles.map((file) =>
          collectConfigDirFiles(fs, projectRoot(fs.dirname(file.path)), visited)
        )
      )
    ).flat();

    const block = formatContextFilesBlock(linked);
    if (!block) return;

    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });
}
