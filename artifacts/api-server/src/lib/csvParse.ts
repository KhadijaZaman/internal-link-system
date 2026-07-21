/**
 * Small pure CSV parser (RFC 4180): quoted fields, escaped quotes ("" inside
 * quotes), CR/LF/CRLF line endings, newlines inside quoted fields. No
 * dependencies, no I/O — unit-tested like chunkText. Used for Bing AI
 * Performance report exports, whose columns Microsoft changes without
 * notice, so header handling must stay tolerant (see routes/bing.ts).
 */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  // Strip a UTF-8 BOM if present (Excel exports often have one).
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    sawAny = true;
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      if (src[i + 1] === "\n") i++;
      pushRow();
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0 || (sawAny && rows.length === 0)) {
    pushRow();
  }
  // Drop fully-empty trailing rows (files often end with a newline).
  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last && last.every((f) => f.trim() === "")) rows.pop();
    else break;
  }
  return rows;
}

/**
 * Convert parsed rows into objects keyed by normalized header
 * (lowercased, non-alphanumerics collapsed to single spaces, trimmed).
 * Returns the raw headers too so callers can persist them for debugging.
 */
export function csvToObjects(text: string): {
  rawHeaders: string[];
  rows: Array<Record<string, string>>;
} {
  const parsed = parseCsv(text);
  const headerRow = parsed[0];
  if (!headerRow) return { rawHeaders: [], rows: [] };
  const keys = headerRow.map(normalizeHeader);
  const rows: Array<Record<string, string>> = [];
  for (let i = 1; i < parsed.length; i++) {
    const cells = parsed[i];
    if (!cells) continue;
    const obj: Record<string, string> = {};
    for (let j = 0; j < keys.length; j++) {
      const k = keys[j];
      if (!k) continue;
      obj[k] = (cells[j] ?? "").trim();
    }
    rows.push(obj);
  }
  return { rawHeaders: headerRow, rows };
}

export function normalizeHeader(h: string): string {
  return h
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
