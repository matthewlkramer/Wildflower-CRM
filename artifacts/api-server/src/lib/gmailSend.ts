/**
 * Thin wrapper around the Gmail "send" REST endpoint. Mirrors the fetch-only
 * style of googleOauth.ts / gmail.ts (no googleapis SDK). Used by the
 * per-recipient tracked-send route to deliver one individualized copy per
 * recipient through the connected user's own mailbox.
 */

export interface SendResult {
  id: string;
  threadId: string;
}

export class GmailSendError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GmailSendError";
  }
}

/**
 * Send one raw (base64url) RFC 822 message. Pass `threadId` to append the copy
 * to an existing thread (so the sender's Sent folder collapses a group send into
 * a single conversation). Throws GmailSendError on a non-2xx response so the
 * caller can decide whether to surface a 502/400 to the extension.
 */
export async function sendRawMessage(
  accessToken: string,
  raw: string,
  threadId?: string | null,
): Promise<SendResult> {
  const body: { raw: string; threadId?: string } = { raw };
  if (threadId) body.threadId = threadId;

  const r = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new GmailSendError(
      `Gmail send failed: ${r.status} ${text}`.slice(0, 500),
      r.status,
    );
  }
  const j = (await r.json()) as { id: string; threadId: string };
  return { id: j.id, threadId: j.threadId };
}
