/**
 * Thin Gmail v1 REST client used by the sync worker. We deliberately
 * avoid the `googleapis` SDK (kept the OAuth code lean for the same
 * reason — see `googleOauth.ts`). All calls are tied to the OAuth
 * access token the worker hands in; we never cache the token here.
 *
 * What's covered:
 *   - getProfile               — current historyId + emailAddress
 *   - listMessageIds           — `users.messages.list` (id + threadId only)
 *   - getMessage(metadata|full)— per-message fetch
 *   - getAttachmentBytes       — fetch a single attachment as Buffer
 *   - listHistory              — incremental delta since last historyId
 *
 * Plus header / payload helpers:
 *   - parseAddressHeader       — pull lowercased email addresses out
 *                                of a To/Cc/Bcc/From header
 *   - extractMessageParts      — walk the payload tree to collect
 *                                bodyText / bodyHtml / attachment refs
 */

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailNotFoundError extends Error {
  constructor(public readonly path: string) {
    super(`Gmail 404: ${path}`);
    this.name = "GmailNotFoundError";
  }
}

export class GmailHistoryGoneError extends Error {
  constructor() {
    super("Gmail historyId has expired; bootstrap required");
    this.name = "GmailHistoryGoneError";
  }
}

async function gmailFetch(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const r = await fetch(`${GMAIL_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });
  if (r.status === 404) throw new GmailNotFoundError(path);
  // Gmail signals "the startHistoryId is too old" with 404 too, but
  // `users.history.list` returns 404 specifically for expired ids and
  // the caller (listHistory) translates that to GmailHistoryGoneError.
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Gmail ${r.status} ${path}: ${text.slice(0, 500)}`);
  }
  return r;
}

export interface GmailProfile {
  emailAddress: string;
  historyId: string;
  messagesTotal: number;
}

export async function getProfile(accessToken: string): Promise<GmailProfile> {
  const r = await gmailFetch(accessToken, "/profile");
  return (await r.json()) as GmailProfile;
}

export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface ListMessagesPage {
  messages: GmailMessageRef[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export async function listMessageIds(
  accessToken: string,
  opts: { q?: string; pageToken?: string | null; maxResults?: number },
): Promise<ListMessagesPage> {
  const sp = new URLSearchParams();
  if (opts.q) sp.set("q", opts.q);
  if (opts.pageToken) sp.set("pageToken", opts.pageToken);
  sp.set("maxResults", String(opts.maxResults ?? 100));
  const r = await gmailFetch(accessToken, `/messages?${sp.toString()}`);
  const j = (await r.json()) as ListMessagesPage;
  return { messages: j.messages ?? [], nextPageToken: j.nextPageToken, resultSizeEstimate: j.resultSizeEstimate };
}

export interface GmailHeader {
  name: string;
  value: string;
}

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailPart[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload: GmailPart;
}

export async function getMessage(
  accessToken: string,
  id: string,
  format: "metadata" | "full",
): Promise<GmailMessage> {
  const sp = new URLSearchParams();
  sp.set("format", format);
  if (format === "metadata") {
    // Bare minimum to do participant matching + display. Anything
    // else is wasted bytes at scale.
    for (const h of ["From", "To", "Cc", "Bcc", "Subject", "Date"]) {
      sp.append("metadataHeaders", h);
    }
  }
  const r = await gmailFetch(accessToken, `/messages/${id}?${sp.toString()}`);
  return (await r.json()) as GmailMessage;
}

export async function getAttachmentBytes(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  const r = await gmailFetch(
    accessToken,
    `/messages/${messageId}/attachments/${attachmentId}`,
  );
  const j = (await r.json()) as { size: number; data: string };
  // Gmail returns base64url; Buffer's "base64url" handles it.
  return Buffer.from(j.data, "base64url");
}

export interface GmailHistoryMessage {
  id: string;
  threadId: string;
}

export interface GmailHistoryItem {
  id: string;
  messages?: GmailHistoryMessage[];
  messagesAdded?: { message: GmailHistoryMessage }[];
}

export interface ListHistoryPage {
  history: GmailHistoryItem[];
  nextPageToken?: string;
  historyId: string;
}

export async function listHistory(
  accessToken: string,
  startHistoryId: string,
  pageToken?: string | null,
): Promise<ListHistoryPage> {
  const sp = new URLSearchParams();
  sp.set("startHistoryId", startHistoryId);
  sp.set("historyTypes", "messageAdded");
  if (pageToken) sp.set("pageToken", pageToken);
  try {
    const r = await gmailFetch(accessToken, `/history?${sp.toString()}`);
    const j = (await r.json()) as ListHistoryPage;
    return { history: j.history ?? [], nextPageToken: j.nextPageToken, historyId: j.historyId };
  } catch (e) {
    if (e instanceof GmailNotFoundError) throw new GmailHistoryGoneError();
    throw e;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Header + payload parsers
// ──────────────────────────────────────────────────────────────────────────

export function getHeader(part: GmailPart, name: string): string | undefined {
  const lname = name.toLowerCase();
  return part.headers?.find((h) => h.name.toLowerCase() === lname)?.value;
}

/**
 * Pull lowercased email addresses out of a raw header value. Handles
 * the common shapes: `Name <addr@x.com>`, `addr@x.com`, comma-
 * separated lists of either. Returns an empty list if none found.
 *
 * Intentionally permissive — RFC 5322 has a lot of edge cases and
 * we'd rather match a few extra addresses (we filter against the
 * `emails` table afterwards anyway) than miss a real one because of
 * weird whitespace.
 */
export function parseAddressHeader(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const tokenRaw of raw.split(",")) {
    const token = tokenRaw.trim();
    if (!token) continue;
    const angle = /<([^>]+)>/.exec(token);
    const candidate = (angle ? angle[1] : token).trim().toLowerCase();
    // Quick sanity: must contain @ and at least one dot in the
    // domain. Strips display names that snuck through.
    if (/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(candidate)) {
      out.push(candidate);
    }
  }
  return out;
}

export interface ExtractedMessage {
  bodyText: string | null;
  bodyHtml: string | null;
  attachments: {
    filename: string;
    mimeType: string;
    attachmentId: string;
    size: number;
  }[];
}

/**
 * Walk a Gmail payload tree and pull out the first text/plain body,
 * the first text/html body, and any attachment refs. "First" in
 * depth-first order matches what Gmail's UI shows — multipart/
 * alternative messages put text/plain ahead of text/html under one
 * parent, and we want the corresponding pair.
 */
export function extractMessageParts(payload: GmailPart): ExtractedMessage {
  let bodyText: string | null = null;
  let bodyHtml: string | null = null;
  const attachments: ExtractedMessage["attachments"] = [];

  const walk = (p: GmailPart): void => {
    const mt = (p.mimeType ?? "").toLowerCase();
    const hasAttachmentId = !!p.body?.attachmentId;
    const hasFilename = !!p.filename;
    // Real attachments: any part with both a filename AND an attachmentId.
    // (Inline images can have an attachmentId without a filename — we
    // skip those for now; T005 can render them by re-fetching if
    // needed.)
    if (hasFilename && hasAttachmentId) {
      attachments.push({
        filename: p.filename ?? "attachment",
        mimeType: p.mimeType ?? "application/octet-stream",
        attachmentId: p.body!.attachmentId!,
        size: p.body?.size ?? 0,
      });
      return;
    }
    if (mt === "text/plain" && p.body?.data && bodyText === null) {
      bodyText = Buffer.from(p.body.data, "base64url").toString("utf8");
      return;
    }
    if (mt === "text/html" && p.body?.data && bodyHtml === null) {
      bodyHtml = Buffer.from(p.body.data, "base64url").toString("utf8");
      return;
    }
    if (p.parts) for (const child of p.parts) walk(child);
  };
  walk(payload);

  return { bodyText, bodyHtml, attachments };
}
