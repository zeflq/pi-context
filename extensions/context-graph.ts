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

    const rootPaths = extractContextPathsFromSystemPrompt(event.systemPrompt);
    if (rootPaths.length === 0) return;

    const rootFiles = (
      await Promise.all(rootPaths.map(async (path) => {
        const content = await fs.read(path);
        return content !== null ? { path, content } : null;
      }))
    ).filter((f): f is { path: string; content: string } => f !== null);

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
