/**
 * Context file auto-discovery extension (layer 2).
 *
 * Reads context file paths already present in the system prompt (injected by
 * ssh-context or pi's native loader), scans their project's config dirs
 * (.pi/, .claude/, .agents/) for .md files with a `description` frontmatter
 * field, and injects a <context-files> block so the agent can load them on
 * demand via the read tool.
 *
 * Works both locally and over SSH.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { localFs, sshFs } from "../src/fs-ops.js";
import { readSshFlag, resolveSshState, type SshState } from "../src/ssh.js";
import { looksLikeFilePath } from "../src/markdown.js";
import { formatContextFilesBlock, collectConfigDirFiles, CONFIG_DIR_NAMES, type LoadedFile } from "../src/loader.js";

/**
 * Extracts both path and content for each context file injected into the
 * system prompt as `## /path/to/file\n\n<content>` sections.
 * Avoids re-reading files via SSH / localFs when the content is already present.
 */
export function extractContextFilesFromSystemPrompt(
  systemPrompt: string,
): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const lines = systemPrompt.split(/\r?\n/);
  let currentPath: string | null = null;
  const currentContent: string[] = [];

  const flush = () => {
    if (currentPath !== null) {
      const content = currentContent.join("\n").trim();
      if (content) files.push({ path: currentPath, content });
    }
    currentContent.length = 0;
  };

  for (const line of lines) {
    const m = line.match(/^## (.+)$/);
    if (m && looksLikeFilePath(m[1].trim())) {
      flush();
      currentPath = m[1].trim();
    } else if (currentPath !== null) {
      currentContent.push(line);
    }
  }
  flush();
  return files;
}

export default function (pi: ExtensionAPI) {
  const sshFlag = readSshFlag();
  let sshState: SshState | null = null;

  const sshStateReady: Promise<void> = sshFlag
    ? resolveSshState(sshFlag)
      .then((s) => { sshState = s; })
      .catch(() => { sshState = null; })
    : Promise.resolve();

  pi.on("before_agent_start", async (event, _ctx) => {
    await sshStateReady;

    const fs = sshState ? sshFs(sshState.remote) : localFs;

    // Use content already present in the system prompt — avoids re-reading
    // root files via SSH (which can fail on Windows) and reduces SSH traffic.
    const rootFiles = extractContextFilesFromSystemPrompt(event.systemPrompt);
    if (rootFiles.length === 0) return;

    const visited = new Set(rootFiles.map((f) => f.path));

    // If AGENTS.md lives inside a config dir (e.g. /project/.pi/AGENTS.md),
    // use the parent as the project root so we scan /project/.pi/ correctly.
    // If it lives directly in the project root (e.g. /project/AGENTS.md),
    // use that directory as-is.
    const projectRoot = (dir: string) => {
      const base = dir.split("/").pop() ?? "";
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
