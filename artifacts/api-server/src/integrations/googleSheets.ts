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
