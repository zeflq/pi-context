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
