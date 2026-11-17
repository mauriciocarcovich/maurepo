// Builds the Markdown brief: general notes, then linked notes and highlights grouped by page or by tag.
import { TAGS, TAG_ORDER, type Annotation } from "./annotations";

export interface BriefOptions {
  title: string;
  pages: number;
  date: string; // YYYY-MM-DD
  general: string;
  annotations: Annotation[];
  groupBy: "page" | "tag";
  includeHighlights: boolean; // highlights that have no note
  includeGeneral: boolean;
}

const quote = (q: string) => q.replace(/\s+/g, " ").trim();

function item(a: Annotation, showPage: boolean, showTag: boolean): string {
  const label = [showPage ? `p. ${a.page + 1}` : "", showTag ? TAGS[a.tag].label : ""].filter(Boolean).join(" · ");
  const note = a.note?.trim();
  let s = `> ${quote(a.quote)}\n`;
  if (label) s += `>\n> — ${label}\n`;
  if (note) s += `\n${note}\n`;
  return s;
}

export function buildBrief(o: BriefOptions): string {
  const list = o.annotations
    .filter((a) => a.note !== null || o.includeHighlights)
    .sort((a, b) => a.page - b.page || a.start - b.start);
  let md = `# ${o.title}\n\n_${o.date} · ${o.pages} page${o.pages === 1 ? "" : "s"}_\n`;
  if (o.includeGeneral && o.general.trim()) md += `\n## Notes\n\n${o.general.trim()}\n`;
  if (!list.length) return md;

  if (o.groupBy === "page") {
    let page = -1;
    for (const a of list) {
      if (a.page !== page) { page = a.page; md += `\n## Page ${page + 1}\n`; }
      md += `\n${item(a, false, true)}`;
    }
  } else {
    for (const t of TAG_ORDER) {
      const group = list.filter((a) => a.tag === t);
      if (!group.length) continue;
      md += `\n## ${TAGS[t].label} (${group.length})\n`;
      for (const a of group) md += `\n${item(a, true, false)}`;
    }
  }
  return md;
}
