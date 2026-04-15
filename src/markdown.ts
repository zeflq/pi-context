export function looksLikeFilePath(value: string): boolean {
  const v = value.trim();
  if (!v || /\s{2,}/.test(v)) return false;
  const hasPathShape =
    v.startsWith("/") ||
    v.startsWith("~/") ||
    /^[A-Za-z]:[\\/]/.test(v) ||
    v.includes("/") ||
    v.includes("\\");
  if (!hasPathShape) return false;
  return /\.[A-Za-z0-9_-]+$/i.test(v);
}

export type ParsedDoc = {
  fromMatter: Record<string, string>;
  raw: string;
};

export function parseFrontmatter(raw: string): ParsedDoc {
  const fm: Record<string, string> = {};
  const fmMatch = raw.match(/^---[\r\n]+([\s\S]*?)[\r\n]+---/);
  if (!fmMatch) return { fromMatter: {}, raw };
  for (const line of fmMatch[1].split(/\r?\n/)) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key) fm[key] = val;
  }
  return { fromMatter: fm, raw };
}

export function extractMarkdownLinks(content: string): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    const href = raw.split("#")[0].trim();
    if (!href) return;
    if (href.startsWith("http://") || href.startsWith("https://")) return;
    if (seen.has(href)) return;
    seen.add(href);
    results.push(href);
  };

  // Standard markdown links: [text](path)
  const mdLinkRe = /\[[^\]]*\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdLinkRe.exec(content)) !== null) {
    push(m[1]);
  }

  // Raw .md references in prose, e.g.:
  //   .pi/REVIEW.md           (dotdir relative)
  //   ./file.md               (explicit relative)
  //   ../docs/guide.md        (parent-relative)
  //   /abs/path/file.md       (Unix absolute)
  //   C:\path\file.md         (Windows absolute)
  //   .\relative\path.md      (Windows relative)
  // Requires at least one "/" or "\" (directory separator) to avoid matching bare
  // filenames like "README.md" that are likely just prose, not file references.
  const rawMdPathRe = /(?:^|[\s("'`>\-])((?:[A-Za-z]:)?[A-Za-z0-9._\-/\\]*[/\\][A-Za-z0-9._\-/\\]*\.md)\b/g;
  while ((m = rawMdPathRe.exec(content)) !== null) {
    push(m[1]);
  }

  return results;
}
