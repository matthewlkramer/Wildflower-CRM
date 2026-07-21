import { logger } from "./logger";

/**
 * Minimal Google Sheets CSV fetcher backed by the Replit Google Drive
 * connector proxy — same pattern as `googleDrive.ts` (fresh token per call,
 * never cached, never logged; explicit not-configured error so callers fail
 * loudly instead of silently skipping).
 *
 * The FY27 coding-form sheet is a Google-native spreadsheet, so bytes can't be
 * fetched with `alt=media`; the Drive v3 `export` endpoint converts the FIRST
 * sheet to CSV, which is exactly the tab the Google Form appends responses to.
 *
 * Pull-only: we never write to the sheet.
 */

const DRIVE_API_BASE =
  process.env["GOOGLE_DRIVE_API_BASE"] ?? "https://www.googleapis.com";

/** Raised when the connector is unavailable or the sheet can't be read. */
export class SheetFetchError extends Error {
  constructor(
    public readonly reason: "not_configured" | "permission" | "not_found" | "fetch_failed",
    message: string,
  ) {
    super(message);
    this.name = "SheetFetchError";
  }
}

function getReplitToken(): string | null {
  if (process.env["REPL_IDENTITY"]) return `repl ${process.env["REPL_IDENTITY"]}`;
  if (process.env["WEB_REPL_RENEWAL"])
    return `depl ${process.env["WEB_REPL_RENEWAL"]}`;
  return null;
}

/** Cheap gate: true when the connector proxy env is present at all. */
export function isGoogleSheetsConfigured(): boolean {
  return Boolean(process.env["REPLIT_CONNECTORS_HOSTNAME"] && getReplitToken());
}

async function fetchAccessToken(): Promise<string> {
  const hostname = process.env["REPLIT_CONNECTORS_HOSTNAME"];
  const token = getReplitToken();
  if (!hostname || !token) {
    throw new SheetFetchError(
      "not_configured",
      "Google Drive connector unavailable: connect Google Drive in the " +
        "integrations panel (missing REPLIT_CONNECTORS_HOSTNAME / repl identity token).",
    );
  }
  const res = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=google-drive`,
    { headers: { Accept: "application/json", X_REPLIT_TOKEN: token } },
  );
  if (!res.ok) {
    throw new SheetFetchError(
      "not_configured",
      `Google Drive connector proxy returned HTTP ${res.status}`,
    );
  }
  const data = (await res.json()) as {
    items?: {
      settings?: {
        access_token?: string;
        oauth?: { credentials?: { access_token?: string } };
      };
    }[];
  };
  const settings = data.items?.[0]?.settings ?? {};
  const accessToken =
    settings.access_token || settings.oauth?.credentials?.access_token;
  if (!accessToken) {
    throw new SheetFetchError(
      "not_configured",
      "Google Drive is not connected (no access_token in connector settings) — " +
        "connect Google Drive in the integrations panel.",
    );
  }
  return accessToken;
}

/**
 * Export a Google Spreadsheet's first sheet as CSV text. Throws
 * `SheetFetchError` with a specific reason on every failure path — callers
 * must never treat a failed fetch as "zero rows".
 */
export async function fetchSpreadsheetCsv(spreadsheetId: string): Promise<string> {
  const accessToken = await fetchAccessToken();
  const url =
    `${DRIVE_API_BASE}/drive/v3/files/${encodeURIComponent(spreadsheetId)}` +
    `/export?mimeType=${encodeURIComponent("text/csv")}&supportsAllDrives=true`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new SheetFetchError(
      "permission",
      `No permission to read spreadsheet ${spreadsheetId} (HTTP ${res.status}) — ` +
        "share the sheet with the connected Google account.",
    );
  }
  if (res.status === 404) {
    throw new SheetFetchError(
      "not_found",
      `Spreadsheet ${spreadsheetId} not found (HTTP 404)`,
    );
  }
  if (!res.ok) {
    throw new SheetFetchError(
      "fetch_failed",
      `Spreadsheet CSV export HTTP ${res.status} for ${spreadsheetId}`,
    );
  }
  const text = await res.text();
  logger.info(
    { spreadsheetId, bytes: text.length },
    "Fetched spreadsheet CSV export",
  );
  return text;
}
