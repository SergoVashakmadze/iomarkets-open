// The tables of a filed HTML document, from its own <table> markup (no OCR, no PDFs, no images).
// Each table is a grid of cells as the browser lays them out: colspan cells cover every column they
// span, so a value can be matched to the header above it. Each row also has the text a reader sees,
// its non-empty cells joined with " | ", which is what an event read from a table quotes
// (extractTable.ts), so the quote can be checked against the filing cell by cell.

import { htmlToText } from './text.ts';

export type Cell = {
  /** The cell's text, as htmlToText gives it. */
  text: string;
  /** The first grid column the cell covers, and how many. */
  col: number;
  span: number;
};

export type Row = { cells: Cell[] };

export type Table = {
  rows: Row[];
  /** A <caption>, or else the heading or short paragraph just before the table, if there is one. */
  heading?: string;
  /** The text of the document before the table (up to 600 characters), for the words around it. */
  before: string;
  /** Characters into the HTML where the table starts: tables in document order. */
  at: number;
};

// Cells that a browser shows stuck to the next or the previous one: "$ | 0.25" is read "$0.25", "0.25 | %" is "0.25%".
const LEADS = /^(?:US\$|U\.S\.\s?\$|\$|€|£|¥|C\$|R\$|A\$|HK\$|\()$/;
const TRAILS = /^(?:%|\)|\)%|%\))$/;

/** A row's cells as read, with a currency sign or bracket in its own cell glued to its neighbour (layout, not content). */
export function readCells(row: Row): Cell[] {
  const out: Cell[] = [];
  let lead: Cell | undefined;
  for (const c of row.cells) {
    if (!c.text) continue;
    if (LEADS.test(c.text)) {
      lead = lead ? { ...lead, text: lead.text + c.text } : c;
      continue;
    }
    if (TRAILS.test(c.text) && out.length && !lead) {
      const p = out[out.length - 1];
      out[out.length - 1] = { ...p, text: p.text + c.text, span: c.col + c.span - p.col };
      continue;
    }
    out.push(lead ? { text: lead.text + c.text, col: lead.col, span: c.col + c.span - lead.col } : c);
    lead = undefined;
  }
  if (lead) out.push(lead);
  return out;
}

/** What a reader sees of a row: its cells, " | " between them. */
export const rowText = (row: Row) => readCells(row).map((c) => c.text).join(' | ');

/** Every table in the document. A table inside a cell of another is read as a table of its own; the outer cell keeps only its own text. */
export function tables(html: string): Table[] {
  const doc = html.replace(/^[\s\S]*?<TEXT>/i, '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, (m) => ' '.repeat(m.length)).replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));
  type Open = { at: number; rows: { cells: { html: string; span: number }[] }[]; cell?: { html: string; span: number }; caption?: string; inCaption?: boolean; captionHtml: string };
  const stack: Open[] = [];
  const done: { t: Open; at: number }[] = [];
  const tag = /<(\/?)(table|tr|td|th|caption)\b([^>]*)>/gi;
  let last = 0;
  let m: RegExpExecArray | null;
  const text = (s: string) => {
    const t = stack[stack.length - 1];
    if (!t) return;
    if (t.inCaption) t.captionHtml += s;
    else if (t.cell) t.cell.html += s;
  };
  while ((m = tag.exec(doc))) {
    text(doc.slice(last, m.index));
    last = m.index + m[0].length;
    const close = m[1] === '/';
    const name = m[2].toLowerCase();
    const t = stack[stack.length - 1];
    if (name === 'table') {
      if (!close) stack.push({ at: m.index, rows: [], captionHtml: '' });
      else if (t) {
        stack.pop();
        done.push({ t, at: t.at });
      }
    } else if (!t) continue;
    else if (name === 'caption') t.inCaption = !close;
    else if (name === 'tr') {
      t.cell = undefined;
      if (!close) t.rows.push({ cells: [] });
    } else if (!close) {
      // <td>/<th>: a new cell (an unclosed one ends here, as in HTML).
      if (!t.rows.length) t.rows.push({ cells: [] });
      const span = Math.min(50, Math.max(1, Number(/\bcolspan\s*=\s*["']?(\d+)/i.exec(m[3])?.[1] ?? 1)));
      t.cell = { html: '', span };
      t.rows[t.rows.length - 1].cells.push(t.cell);
    } else t.cell = undefined;
  }
  return done
    .sort((a, b) => a.at - b.at)
    .map(({ t }) => {
      const rows: Row[] = t.rows
        .map((r) => {
          let col = 0;
          const cells = r.cells.map((c) => {
            const cell = { text: htmlToText(c.html), col, span: c.span };
            col += c.span;
            return cell;
          });
          return { cells };
        })
        .filter((r) => r.cells.some((c) => c.text));
      const caption = htmlToText(t.captionHtml);
      const before = htmlToText(doc.slice(Math.max(0, t.at - 4000), t.at)).slice(-600);
      return { rows, at: t.at, before, heading: caption || headingBefore(doc, t.at) };
    })
    .filter((t) => t.rows.length);
}

/** The block of text just before a table, when it is short enough to be its heading ("Dividend timetable", "The dates are as follows:"). */
function headingBefore(doc: string, at: number): string | undefined {
  let prior = doc.slice(Math.max(0, at - 3000), at);
  // Not the last row of a table just before this one.
  const end = prior.search(/<\/table>(?![\s\S]*<\/table>)/i);
  if (end >= 0) prior = prior.slice(end + 8);
  // The last block-level element's text before the table.
  const blocks = prior.split(/<\/?(?:p|div|h[1-6]|br|li|table|tr)\b[^>]*>/i).map(htmlToText).filter(Boolean);
  const h = blocks[blocks.length - 1];
  return h && h.length <= 200 ? h : undefined;
}
