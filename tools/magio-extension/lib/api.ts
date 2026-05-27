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

export type TrackingData = {
  id: string;
  subject: string;
  sender: string;
  recipient: string;
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
