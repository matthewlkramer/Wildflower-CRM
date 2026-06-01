// Vendored from upstream Magio (apps/extension/lib/api.ts) and
// repointed at the Wildflower CRM's /api/email-tracking routes.
//
// All URLs here MUST stay in sync with the OpenAPI spec
// (`lib/api-spec/openapi.yaml`, tag `email-tracking`). Upstream used
// `/api/emails` and `/api/track/[id].gif`; ours nests everything under
// `/api/email-tracking` so it doesn't collide with the CRM's existing
// `/api/emails` router (which is the synced-Gmail messages router, a
// different thing).

const API_BASE_URL =
  process.env.PLASMO_PUBLIC_API_URL || 'http://localhost:3000';

const POST_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

export async function registerEmail(
  subject: string,
  recipient: string,
  sender: string
): Promise<{ id: string } | null> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/email-tracking`, {
      method: 'POST',
      headers: POST_HEADERS,
      body: JSON.stringify({ subject, recipient, sender }),
    });
    if (res.ok) return res.json();
    console.error('[WildflowerTracking] Server error:', await res.text());
    return null;
  } catch (err) {
    console.error('[WildflowerTracking] Network error:', err);
    return null;
  }
}

export function getPixelUrl(emailId: string): string {
  return `${API_BASE_URL}/api/email-tracking/track/${emailId}.gif`;
}

// Per-recipient server-send (Path A). The server splits the group into one
// individualized copy per recipient — each showing the full To/Cc group but
// carrying a unique tracking pixel — and sends them through the caller's own
// Gmail (resolved from the extension token).
//
// The outcome distinguishes three cases so the caller never double-sends:
//   - 'sent'      — all copies delivered; discard the Gmail draft.
//   - 'not_sent'  — the server rejected BEFORE delivering anything (bad body,
//                   Google not connected, missing scope, or a 502 whose
//                   details.sent is empty = the very first copy failed). Safe to
//                   fall back to the legacy single-pixel + Gmail-send path.
//   - 'uncertain' — a copy MAY already be out (partial 502, unknown 5xx, or no
//                   response). The caller must NOT auto-resend via Gmail, or it
//                   would duplicate to recipients who already received a copy.
export type SendTrackedEmailOutcome =
  | { status: 'sent'; groupId: string; recipients: { id: string; recipient: string }[] }
  | { status: 'not_sent' }
  | { status: 'uncertain' };

export async function sendTrackedEmail(args: {
  token: string;
  subject: string;
  html: string;
  to: string[];
  cc?: string[];
}): Promise<SendTrackedEmailOutcome> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE_URL}/api/email-tracking/send`, {
      method: 'POST',
      headers: { ...POST_HEADERS, 'X-Extension-Token': args.token },
      body: JSON.stringify({
        subject: args.subject,
        html: args.html,
        to: args.to,
        cc: args.cc && args.cc.length > 0 ? args.cc : undefined,
      }),
    });
  } catch (err) {
    // No response — we can't know whether the server delivered anything.
    console.error('[WildflowerTracking] Send network error:', err);
    return { status: 'uncertain' };
  }

  if (res.ok) {
    try {
      const data = await res.json();
      return {
        status: 'sent',
        groupId: data.groupId,
        recipients: data.recipients ?? [],
      };
    } catch {
      // The copies were delivered (2xx) but we couldn't read the body — never
      // resend, but we also can't report counts.
      return { status: 'sent', groupId: '', recipients: [] };
    }
  }

  let body: { details?: { sent?: unknown } } | null = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  // 400/401/409 are all returned before any copy is sent.
  if (res.status === 400 || res.status === 401 || res.status === 409) {
    return { status: 'not_sent' };
  }
  // 502 carries details.sent: an empty array means the first copy failed, so
  // nothing went out; a non-empty array is a partial send.
  if (res.status === 502) {
    const sent = body?.details?.sent;
    if (Array.isArray(sent) && sent.length === 0) return { status: 'not_sent' };
    return { status: 'uncertain' };
  }
  console.error('[WildflowerTracking] Send error:', res.status, body);
  return { status: 'uncertain' };
}

// One entry per recipient in a per-recipient send group, aggregated by the
// /search handler. Present only for groups sent via Path A; absent (or a single
// entry) for legacy single-pixel sends.
export type TrackingRecipient = {
  id: string;
  recipient: string;
  totalViews: number;
  lastView: string | null;
};

export type TrackingData = {
  id: string;
  subject: string;
  sender: string;
  recipient: string;
  groupId?: string | null;
  recipients?: TrackingRecipient[];
  totalViews: number;
  uniqueIps: number;
  lastView: string | null;
  views: {
    viewedAt: string;
    ipAddress: string | null;
    userAgent: string | null;
    // The CRM backend doesn't enrich with geo/UA parsing (Magio's web
    // app does, ours doesn't); the sidebar code falls back to local UA
    // parsing when these are missing.
    city?: string | null;
    region?: string | null;
    country?: string | null;
    browser?: string | null;
    os?: string | null;
    device?: string | null;
  }[];
};

export async function fetchTrackingData(
  subject: string
): Promise<TrackingData | null> {
  try {
    const res = await fetch(
      `${API_BASE_URL}/api/email-tracking/search?subject=${encodeURIComponent(subject)}`
    );
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export async function deleteLatestTrackingView(
  emailId: string
): Promise<boolean> {
  try {
    const res = await fetch(
      `${API_BASE_URL}/api/email-tracking/${emailId}/views/latest`,
      { method: 'DELETE' }
    );
    return res.ok;
  } catch {
    return false;
  }
}

export type EmailStatus = { subject: string; viewCount: number };

export async function fetchAllTrackingStatuses(): Promise<EmailStatus[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/api/email-tracking/status`);
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}
