export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export type Cell = string | number | null | undefined;

export function cleanCell(value: Cell): string {
  const cleaned = String(value ?? "")
    .replace(/[\t\r\n]+/g, " ")
    .trim();
  // Neutralize spreadsheet formula injection: cells beginning with =, +, -, @
  // are executed as formulas by Excel/Sheets on paste. GSC query strings are
  // externally influenceable, so prefix those with a single quote.
  if (/^[=+\-@]/.test(cleaned)) {
    return `'${cleaned}`;
  }
  return cleaned;
}

export function rowsToTsv(headers: string[], rows: Cell[][]): string {
  const lines = [
    headers.map(cleanCell).join("\t"),
    ...rows.map((row) => row.map(cleanCell).join("\t")),
  ];
  return lines.join("\n");
}
