import { logger } from "./logger";

/**
 * Minimal Google Drive REST client backed by the Replit Google Drive connector
 * proxy. Read-only: we fetch a file's metadata and its bytes by id. Mirrors the
 * Airtable connector pattern (`airtableClient.ts`).
 *
 * Auth: the connector proxy at `REPLIT_CONNECTORS_HOSTNAME` serves a fresh
 * OAuth2 access token on every call. We NEVER cache the token — the proxy
 * resolves the org's authorized Google account and rotates tokens
 * automatically. The token is never logged; only HTTP status / file ids are.
 *
 * Pull-only: used by the one-time grant-agreement document backfill (Task #485).
 * We never write to Drive.
 */

const DRIVE_API_BASE =
  process.env["GOOGLE_DRIVE_API_BASE"] ?? "https://www.googleapis.com";

/** Raised when no Google Drive credential can be resolved — callers fail loudly. */
export class DriveNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveNotConfiguredError";
  }
}

/** Per-link, recoverable failure reasons surfaced to the reviewer per-row. */
export type DriveLinkErrorReason =
  | "unparseable" // the captured link has no extractable Drive file id
  | "not_found" // 404 — file id does not exist
  | "permission" // 403 / 401 — the connected account can't read this file
  | "trashed" // the file is in the owner's trash
  | "unsupported_type" // not an attachable document (Google-native doc / unknown type)
  | "empty" // the download returned no bytes
  | "fetch_failed"; // transient/unexpected HTTP or network error

/** A recoverable, per-row Drive error (recorded on the row, not a 500). */
export class DriveLinkError extends Error {
  constructor(
    public readonly reason: DriveLinkErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "DriveLinkError";
  }
}

function getReplitToken(): string | null {
  if (process.env["REPL_IDENTITY"]) return `repl ${process.env["REPL_IDENTITY"]}`;
  if (process.env["WEB_REPL_RENEWAL"])
    return `depl ${process.env["WEB_REPL_RENEWAL"]}`;
  return null;
}

/**
 * Cheap, side-effect-free check used by no-op gates. True when the connector
 * proxy env is present at all. Does NOT prove a Google account is actually
 * linked (that only fails on the first real call).
 */
export function isGoogleDriveConfigured(): boolean {
  return Boolean(process.env["REPLIT_CONNECTORS_HOSTNAME"] && getReplitToken());
}

/**
 * Resolve a fresh Google Drive access token from the connector proxy. Never
 * cached, never logged.
 */
async function fetchAccessToken(): Promise<string> {
  const hostname = process.env["REPLIT_CONNECTORS_HOSTNAME"];
  const token = getReplitToken();
  if (!hostname || !token) {
    throw new DriveNotConfiguredError(
      "Google Drive connector unavailable: connect Google Drive in the " +
        "integrations panel (missing REPLIT_CONNECTORS_HOSTNAME / repl identity token).",
    );
  }

  const res = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=google-drive`,
    { headers: { Accept: "application/json", X_REPLIT_TOKEN: token } },
  );
  if (!res.ok) {
    throw new DriveNotConfiguredError(
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
    throw new DriveNotConfiguredError(
      "Google Drive is not connected (no access_token in connector settings) — " +
        "connect Google Drive in the integrations panel.",
    );
  }
  return accessToken;
}

/**
 * Extract a Google Drive file id from a captured link. Handles the common
 * shapes seen in the coding-form export:
 *   - https://drive.google.com/open?id=<ID>
 *   - https://drive.google.com/file/d/<ID>/view
 *   - https://drive.google.com/uc?id=<ID>&export=download
 *   - https://docs.google.com/document/d/<ID>/edit
 *   - a bare file id
 * Returns null when no id can be confidently extracted.
 */
export function extractDriveFileId(link: string | null | undefined): string | null {
  if (!link) return null;
  const raw = link.trim();
  if (!raw) return null;

  // `?id=<ID>` or `&id=<ID>` query forms.
  const idParam = raw.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (idParam) return idParam[1];

  // `/d/<ID>` path form (files, documents, spreadsheets, presentations).
  const dPath = raw.match(/\/d\/([A-Za-z0-9_-]+)/);
  if (dPath) return dPath[1];

  // A bare id (no slashes, no scheme) of plausible Drive-id length.
  if (/^[A-Za-z0-9_-]{20,}$/.test(raw)) return raw;

  return null;
}

export interface DriveFile {
  fileId: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
}

interface DriveMetadata {
  id: string;
  name: string;
  mimeType: string;
  trashed?: boolean;
  size?: string;
}

/**
 * Attachable grant-letter document types — mirrors the manual grant-letter
 * upload's accept list (`application/pdf, image/*, .doc, .docx`). Real coding-form
 * uploads are frequently phone photos / screenshots of a signed agreement, not
 * PDFs, so the importer accepts the same set the UI does.
 */
const ALLOWED_DOC_MIME = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const ALLOWED_DOC_EXT = /\.(pdf|jpe?g|png|gif|webp|hei[cf]|bmp|tiff?|docx?)$/i;

function mimeFromExtension(name: string): string {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  switch (ext) {
    case "pdf":
      return "application/pdf";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "heic":
    case "heif":
      return "image/heif";
    case "bmp":
      return "image/bmp";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "doc":
      return "application/msword";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return "application/octet-stream";
  }
}

/**
 * Decide whether a downloaded Drive file is an attachable document and resolve
 * the content-type to store it under. Trusts Drive's mimeType / filename (the
 * manual upload does no content sniffing either); only a PDF-claiming file is
 * magic-checked, so a corrupt/truncated PDF is still caught.
 */
function classifyDocument(
  meta: DriveMetadata,
  bytes: Buffer,
): { ok: boolean; contentType: string } {
  const mime = meta.mimeType ?? "";
  const name = meta.name ?? "";
  if (mime.startsWith("image/")) return { ok: true, contentType: mime };
  if (ALLOWED_DOC_MIME.has(mime)) {
    if (mime === "application/pdf") {
      const byMagic =
        bytes.length >= 4 && bytes.subarray(0, 4).toString("latin1") === "%PDF";
      if (!byMagic) return { ok: false, contentType: mime };
    }
    return { ok: true, contentType: mime };
  }
  // Drive sometimes reports a generic/empty mime — fall back to the extension.
  if (ALLOWED_DOC_EXT.test(name)) {
    return { ok: true, contentType: mime || mimeFromExtension(name) };
  }
  return { ok: false, contentType: mime };
}

/**
 * Fetch a Drive file's metadata and bytes by id, validating it is an attachable
 * document (PDF, image, or Word doc — mirrors the manual grant-letter upload).
 * Throws `DriveLinkError` (with a `reason`) for recoverable per-row problems and
 * `DriveNotConfiguredError` when the connector itself is unavailable.
 */
export async function fetchDriveFile(fileId: string): Promise<DriveFile> {
  const accessToken = await fetchAccessToken();
  const auth = { Authorization: `Bearer ${accessToken}` };

  // 1. Metadata (also tells us trashed / mimeType before downloading bytes).
  const metaUrl =
    `${DRIVE_API_BASE}/drive/v3/files/${encodeURIComponent(fileId)}` +
    `?fields=id,name,mimeType,trashed,size&supportsAllDrives=true`;
  const metaRes = await fetch(metaUrl, { headers: { ...auth, Accept: "application/json" } });
  if (metaRes.status === 404) {
    throw new DriveLinkError("not_found", `Drive file ${fileId} not found`);
  }
  if (metaRes.status === 401 || metaRes.status === 403) {
    throw new DriveLinkError(
      "permission",
      `No permission to read Drive file ${fileId} (HTTP ${metaRes.status})`,
    );
  }
  if (!metaRes.ok) {
    throw new DriveLinkError(
      "fetch_failed",
      `Drive metadata HTTP ${metaRes.status} for ${fileId}`,
    );
  }
  const meta = (await metaRes.json()) as DriveMetadata;
  if (meta.trashed) {
    throw new DriveLinkError("trashed", `Drive file ${fileId} is in the trash`);
  }
  // Google-native formats (Docs/Sheets/Slides) can't be fetched with alt=media —
  // reject early with a clear reason.
  if (meta.mimeType && meta.mimeType.startsWith("application/vnd.google-apps")) {
    throw new DriveLinkError(
      "unsupported_type",
      `Drive file ${fileId} is a Google-native ${meta.mimeType} and can't be downloaded`,
    );
  }

  // 2. Bytes.
  const mediaUrl =
    `${DRIVE_API_BASE}/drive/v3/files/${encodeURIComponent(fileId)}` +
    `?alt=media&supportsAllDrives=true`;
  const mediaRes = await fetch(mediaUrl, { headers: auth });
  if (mediaRes.status === 401 || mediaRes.status === 403) {
    throw new DriveLinkError(
      "permission",
      `No permission to download Drive file ${fileId} (HTTP ${mediaRes.status})`,
    );
  }
  if (mediaRes.status === 404) {
    throw new DriveLinkError("not_found", `Drive file ${fileId} not found`);
  }
  if (!mediaRes.ok) {
    throw new DriveLinkError(
      "fetch_failed",
      `Drive download HTTP ${mediaRes.status} for ${fileId}`,
    );
  }
  const bytes = Buffer.from(await mediaRes.arrayBuffer());
  if (bytes.length === 0) {
    throw new DriveLinkError("empty", `Drive file ${fileId} downloaded 0 bytes`);
  }
  const { ok, contentType } = classifyDocument(meta, bytes);
  if (!ok) {
    throw new DriveLinkError(
      "unsupported_type",
      `Drive file ${fileId} (${meta.mimeType || "unknown type"}) is not an attachable document`,
    );
  }

  const filename = meta.name?.trim() || fileId;

  logger.info(
    { fileId, size: bytes.length, contentType },
    "Fetched Drive grant-agreement file",
  );
  return { fileId, filename, contentType, bytes };
}
