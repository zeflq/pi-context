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
  const re = /\[([^\]]*)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const href = m[2].split("#")[0].trim();
    if (!href || href.startsWith("https://") || href.startsWith("http://")) continue;
    results.push(href);
  }
  return results;
}
