const API = "https://api.zoom.us/v2";
const MAX_TRANSCRIPT_BYTES = 2_000_000;
let cachedToken: { value: string; until: number } | undefined;

export function zoomCaptureAccount() {
  if (process.env.ZOOM_FORWFCRM_TRANSCRIPTS_ENABLED !== "true") return null;
  const accountId = process.env.ZOOM_FORWFCRM_ACCOUNT_ID?.trim();
  const clientId = process.env.ZOOM_FORWFCRM_CLIENT_ID?.trim();
  const clientSecret = process.env.ZOOM_FORWFCRM_CLIENT_SECRET?.trim();
  return accountId && clientId && clientSecret
    ? { accountId, clientId, clientSecret }
    : null;
}

export class ZoomRequestError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
  ) {
    super("Zoom request failed");
  }
}

async function accessToken() {
  const config = zoomCaptureAccount();
  if (!config) throw new Error("Zoom transcript integration is disabled");
  if (cachedToken && Date.now() < cachedToken.until) return cachedToken.value;
  const body = new URLSearchParams({
    grant_type: "account_credentials",
    account_id: config.accountId,
  });
  const credentials = Buffer.from(
    config.clientId + ":" + config.clientSecret,
  ).toString("base64");
  const response = await fetch("https://zoom.us/oauth/token", {
    method: "POST",
    headers: { Authorization: "Basic " + credentials },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new ZoomRequestError("token", response.status);
  const token = (await response.json()) as {
    access_token: string;
    expires_in: number;
  };
  cachedToken = {
    value: token.access_token,
    until: Date.now() + (token.expires_in - 60) * 1_000,
  };
  return cachedToken.value;
}

async function authorized(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: "Bearer " + (await accessToken()),
    },
    signal: AbortSignal.timeout(12_000),
    redirect: init?.redirect ?? "error",
  });
  if (response.status === 401) cachedToken = undefined;
  return response;
}

export async function startZoomTranscript(meetingId: string) {
  const response = await authorized(
    API + "/live_meetings/" + encodeURIComponent(meetingId) + "/events",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        method: "ai_companion.start",
        params: {
          ai_companion_mode: "summary",
          retain_meeting_transcript: true,
        },
      }),
    },
  );
  if (!response.ok) throw new ZoomRequestError("start", response.status);
}

function isZoomDownload(url: URL) {
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    (url.hostname === "zoom.us" || url.hostname.endsWith(".zoom.us"))
  );
}

function isSignedStorageRedirect(url: URL) {
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    return false;
  const host = url.hostname;
  return (
    ((host === "s3.amazonaws.com" ||
      /\.s3[.-][a-z0-9.-]+\.amazonaws\.com$/.test(host)) &&
      url.searchParams.has("X-Amz-Signature")) ||
    (host.endsWith(".cloudfront.net") &&
      url.searchParams.has("Signature") &&
      url.searchParams.has("Key-Pair-Id"))
  );
}

export async function downloadZoomTranscript(
  uuid: string,
): Promise<string | null> {
  let encoded = encodeURIComponent(uuid);
  if (uuid.startsWith("/") || uuid.includes("//"))
    encoded = encodeURIComponent(encoded);
  const response = await authorized(
    API + "/meetings/" + encoded + "/transcript",
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new ZoomRequestError("transcript", response.status);
  const metadata = (await response.json()) as {
    can_download?: boolean;
    download_url?: string;
  };
  if (!metadata.can_download || !metadata.download_url) return null;
  let url = new URL(metadata.download_url);
  // Never forward the account token to an external host.
  for (let hop = 0; hop < 4; hop++) {
    const zoomHost = isZoomDownload(url);
    if (!zoomHost && (hop === 0 || !isSignedStorageRedirect(url)))
      throw new Error("Unexpected Zoom transcript download host");
    const file = zoomHost
      ? await authorized(url.href, { redirect: "manual" })
      : await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(12_000),
        });
    if (file.status >= 300 && file.status < 400) {
      const location = file.headers.get("location");
      await file.body?.cancel();
      if (!location) break;
      url = new URL(location, url);
      continue;
    }
    if (!file.ok || !file.body)
      throw new ZoomRequestError("download", file.status);
    const reader = file.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    let transcript = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_TRANSCRIPT_BYTES) {
        await reader.cancel();
        throw new Error("Zoom transcript exceeds the import size limit");
      }
      transcript += decoder.decode(value, { stream: true });
    }
    transcript = (transcript + decoder.decode()).trim();
    if (
      /^(?:<!doctype\s+html|<html\b)/i.test(transcript) ||
      transcript.includes("\0")
    )
      throw new Error("Zoom transcript download was not text");
    return transcript.replace(/^WEBVTT[^\r\n]*[\r\n]*/, "").trim() || null;
  }
  throw new Error("Unexpected Zoom transcript download redirect");
}
