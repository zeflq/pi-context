/**
 * Link-following context graph extension (layer 2).
 *
 * Reads context file paths already present in the current system prompt
 * (typically injected by ssh-context under "# Project Context"), reads each
 * file from disk, recursively follows markdown links, and injects linked-file
 * stubs so the LLM can pull them on demand.
 *
 * Works both locally and over SSH.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { localFs, sshFs } from "../src/fs-ops.js";
import { readSshFlag, resolveSshState, type SshState } from "../src/ssh.js";
import { extractMarkdownLinks, looksLikeFilePath } from "../src/markdown.js";
import { formatLinkedFilesBlock, collectLinkedFiles, type LoadedFile } from "../src/loader.js";

export function extractContextPathsFromSystemPrompt(systemPrompt: string): string[] {
  const paths: string[] = [];
  for (const line of systemPrompt.split(/\r?\n/)) {
    const match = line.match(/^##\s+(.+)$/);
    if (match && looksLikeFilePath(match[1])) {
      paths.push(match[1].trim());
    }
  }
  return paths;
}

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

    const linkedNested = await Promise.all(
      rootFiles.map((file) =>
        Promise.all(
          extractMarkdownLinks(file.content).map(async (link) => {
            const linkedPath = fs.join(fs.dirname(file.path), link);
            if (await fs.exists(linkedPath)) {
              return collectLinkedFiles(fs, linkedPath, visited, 0, 10);
            }
            return [];
          })
        )
      )
    );
    const linked: LoadedFile[] = linkedNested.flat(2);

    const linkedBlock = formatLinkedFilesBlock(linked);
    if (!linkedBlock) return;

    return { systemPrompt: `${event.systemPrompt}\n\n${linkedBlock}` };
  });
}
