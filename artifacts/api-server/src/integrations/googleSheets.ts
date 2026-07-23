// Google Sheets access via the Replit "google-sheet" connector integration.
// The SDK proxy handles identity, token refresh, and auth headers — never
// cache clients or tokens (they expire). Plain objects passed as `body` are
// JSON-stringified by the SDK with the correct Content-Type.
import { ReplitConnectors } from "@replit/connectors-sdk";

export async function sheetsRequest<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const connectors = new ReplitConnectors();
  const res = await connectors.proxy("google-sheet", path, {
    method: init?.method ?? "GET",
    body: init?.body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Google Sheets API ${init?.method ?? "GET"} ${path} failed (${res.status}): ${text.slice(0, 500)}`,
    );
  }
  return (await res.json()) as T;
}

/**
 * Make a spreadsheet readable by anyone with the link via the Google Drive
 * permissions API (google-drive connector — same Google account, but a
 * separate connector authorization from google-sheet).
 *
 * Never throws: returns true when the permission is in place, false when the
 * Drive connector isn't connected or the call fails, so sheet exports keep
 * working even before Drive is authorized. Callers surface the false case in
 * the UI ("you may need to request access").
 */
export async function shareSheetWithAnyone(
  spreadsheetId: string,
): Promise<boolean> {
  try {
    const connectors = new ReplitConnectors();
    const res = await connectors.proxy(
      "google-drive",
      `/v3/files/${spreadsheetId}/permissions`,
      { method: "POST", body: { role: "reader", type: "anyone" } },
    );
    return res.ok;
  } catch {
    return false;
  }
}
