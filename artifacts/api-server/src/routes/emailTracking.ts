import { Router, type IRouter } from "express";
import { randomBytes } from "node:crypto";
import { db } from "@workspace/db";
import {
  emails as emailsTable,
  trackedEmails,
  trackedEmailViews,
  users,
} from "@workspace/db/schema";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { requireExtensionToken } from "../middlewares/requireExtensionToken";
import { asyncHandler, newId, notFound, paramId } from "../lib/helpers";
import {
  CreateTrackedEmailBody as CreateTrackedEmailBodyZ,
  SendTrackedEmailBody as SendTrackedEmailBodyZ,
} from "@workspace/api-zod";
import { getAppUser } from "../lib/appRequest";
import { getValidGoogleAccessTokenForUser } from "../lib/googleTokenStore";
import { GMAIL_SEND_SCOPE } from "../lib/googleOauth";
import { buildRawMessage } from "../lib/mime";
import { sendRawMessage, GmailSendError } from "../lib/gmailSend";

/**
 * Self-hosted backend for the vendored Magio email-tracking extension
 * (see tools/magio-extension/). Auth posture:
 *
 *   - POST /email-tracking, GET .../search, .../status, DELETE .../views/latest
 *     are UNAUTHENTICATED. The extension is end-user installed and
 *     speaks raw HTTP from the mail.google.com origin — matches upstream
 *     Magio's design. The user explicitly opted out of API-key auth.
 *
 *   - GET /email-tracking, /email-tracking/{id}, /email-tracking/by-contact
 *     require auth (CRM dashboard consumers).
 *
 * Pixel endpoint (/track/{id}.gif) is mounted on this router (not in the
 * OpenAPI spec — binary response, no client codegen). It must be
 * registered BEFORE /:id so Express doesn't try to match "track" as the
 * id parameter.
 */
const router: IRouter = Router();

/**
 * How far back `DELETE /email-tracking/:id/views/latest` reaches when the
 * sidebar asks us to scrub a sender self-view (e.g. sender opened on a
 * different network so the IP check didn't suppress it).
 */
const SENDER_PEEK_WINDOW_MS = 5 * 60_000;

/**
 * 1×1 transparent GIF, base64-decoded once at module load.
 * https://en.wikipedia.org/wiki/Web_beacon#Implementation
 */
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
const PIXEL_HEADERS = {
  "Content-Type": "image/gif",
  "Cache-Control":
    "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};

/** Extract the recipient IP from proxy headers, then the socket. */
function getRequestIp(req: import("express").Request): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real.length > 0) return real;
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

/**
 * Parse the To: line as scraped by the extension (Gmail gives back a
 * comma-or-semicolon separated string of bare addresses) into a
 * lowercased, deduped list. Anything that doesn't contain `@` is
 * discarded — the extension occasionally yields "Unknown Recipient"
 * for replies where it can't find the To: input.
 */
function parseRecipients(raw: string): string[] {
  const out = new Set<string>();
  for (const part of raw.split(/[,;]/)) {
    const trimmed = part.trim().toLowerCase();
    if (trimmed && trimmed.includes("@")) out.add(trimmed);
  }
  return Array.from(out);
}

/**
 * For each recipient address, look up which CRM contact it belongs to
 * via the `emails` table (which is owner-exclusive: each row points
 * at exactly one of person/funder/household/organization/payment-
 * intermediary). We surface person/funder/household into separate
 * arrays so the by-contact endpoint can use array containment without
 * dispatching on contact kind.
 */
async function resolveLinks(addresses: string[]): Promise<{
  personIds: string[];
  funderIds: string[];
  householdIds: string[];
}> {
  if (addresses.length === 0) {
    return { personIds: [], funderIds: [], householdIds: [] };
  }
  const rows = await db
    .select({
      personId: emailsTable.personId,
      funderId: emailsTable.funderId,
      householdId: emailsTable.householdId,
    })
    .from(emailsTable)
    .where(inArray(sql`lower(${emailsTable.email})`, addresses));
  const personIds = new Set<string>();
  const funderIds = new Set<string>();
  const householdIds = new Set<string>();
  for (const r of rows) {
    if (r.personId) personIds.add(r.personId);
    if (r.funderId) funderIds.add(r.funderId);
    if (r.householdId) householdIds.add(r.householdId);
  }
  return {
    personIds: Array.from(personIds),
    funderIds: Array.from(funderIds),
    householdIds: Array.from(householdIds),
  };
}

type ViewRow = {
  id: string;
  viewedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
};

function shapeViews(rows: ViewRow[]) {
  return rows.map((v) => ({
    id: v.id,
    viewedAt: v.viewedAt.toISOString(),
    ipAddress: v.ipAddress,
    userAgent: v.userAgent,
  }));
}

function shapeWithViews(
  email: typeof trackedEmails.$inferSelect,
  views: ViewRow[],
) {
  const uniqueIps = new Set(
    views.map((v) => v.ipAddress).filter((x): x is string => !!x),
  );
  return {
    id: email.id,
    subject: email.subject,
    recipient: email.recipient,
    sender: email.sender,
    senderIp: email.senderIp,
    recipientPersonIds: email.recipientPersonIds,
    recipientFunderIds: email.recipientFunderIds,
    recipientHouseholdIds: email.recipientHouseholdIds,
    createdAt: email.createdAt.toISOString(),
    totalViews: views.length,
    uniqueIps: uniqueIps.size,
    lastView: views[0]?.viewedAt.toISOString() ?? null,
    views: shapeViews(views),
  };
}

/**
 * Public origin the recipient's mail client can reach to load the pixel. The
 * server injects the pixel for per-recipient sends, so (unlike the extension,
 * which knows its own API base) the server must derive an absolute URL. Prefer
 * an explicit override, then the published domain, then the dev domain.
 */
function publicBaseUrl(): string {
  const override = process.env.PUBLIC_BASE_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  const domains = (process.env.REPLIT_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const host = domains[0] ?? process.env.REPLIT_DEV_DOMAIN?.trim();
  return host ? `https://${host.replace(/\/+$/, "")}` : "";
}

function pixelUrlFor(id: string): string {
  return `${publicBaseUrl()}/api/email-tracking/track/${id}.gif`;
}

/** Append the 1×1 tracking pixel to an HTML body for a given pixel id. */
function injectPixel(html: string, id: string): string {
  const img = `<img src="${pixelUrlFor(id)}" width="1" height="1" alt="" style="display:none;width:1px;height:1px;border:0;" />`;
  return `${html}${img}`;
}

/**
 * Load every tracked_emails row belonging to the same group send (or just the
 * one row for a legacy single-pixel send). Ordered by send time then address so
 * the per-recipient breakdown is stable.
 */
async function loadGroupRows(
  email: typeof trackedEmails.$inferSelect,
): Promise<(typeof trackedEmails.$inferSelect)[]> {
  if (!email.groupId) return [email];
  return db
    .select()
    .from(trackedEmails)
    .where(eq(trackedEmails.groupId, email.groupId))
    .orderBy(asc(trackedEmails.createdAt), asc(trackedEmails.recipient));
}

/**
 * Shape a matched tracked email into the detail/search response, group-aware:
 * for a group send the top-level aggregate fields (totalViews/uniqueIps/views)
 * sum across the whole group and `recipients[]` carries the per-person
 * breakdown; for a legacy single send `recipients[]` has one entry.
 */
async function shapeGroupWithViews(email: typeof trackedEmails.$inferSelect) {
  const rows = await loadGroupRows(email);
  const ids = rows.map((r) => r.id);
  const allViews = await db
    .select({
      emailId: trackedEmailViews.emailId,
      id: trackedEmailViews.id,
      viewedAt: trackedEmailViews.viewedAt,
      ipAddress: trackedEmailViews.ipAddress,
      userAgent: trackedEmailViews.userAgent,
    })
    .from(trackedEmailViews)
    .where(inArray(trackedEmailViews.emailId, ids))
    .orderBy(desc(trackedEmailViews.viewedAt));

  const byEmail = new Map<string, ViewRow[]>();
  for (const id of ids) byEmail.set(id, []);
  for (const v of allViews) byEmail.get(v.emailId)?.push(v);

  const recipients = rows.map((r) => {
    const vs = byEmail.get(r.id) ?? [];
    return {
      id: r.id,
      recipient: r.recipient,
      totalViews: vs.length,
      lastView: vs[0]?.viewedAt.toISOString() ?? null,
    };
  });

  return {
    ...shapeWithViews(email, allViews),
    groupId: email.groupId,
    gmailMessageId: email.gmailMessageId,
    gmailThreadId: email.gmailThreadId,
    recipients,
  };
}

// ─── Pixel endpoint (must be registered before /:id) ───────────────────────
//
// Express params don't split on `.`, so a route like `/track/:id.gif` would
// give us `id="abc.gif"`. Match :filename and strip the extension.
router.get(
  "/email-tracking/track/:filename",
  asyncHandler(async (req, res) => {
    const filename = String(req.params.filename ?? "");
    const id = filename.replace(/\.gif$/i, "");
    if (!id) {
      res.status(200).set(PIXEL_HEADERS).send(PIXEL);
      return;
    }

    const ip = getRequestIp(req);
    const userAgent = (req.headers["user-agent"] as string | undefined) ?? null;

    const email = await db
      .select()
      .from(trackedEmails)
      .where(eq(trackedEmails.id, id))
      .then((r) => r[0]);

    // Always return the pixel — never leak whether the id exists.
    if (!email) {
      res.status(200).set(PIXEL_HEADERS).send(PIXEL);
      return;
    }

    // Suppress two classes of non-human opens:
    //
    // 1. Gmail delivery-time proxy fetch (GoogleImageProxy UA, early):
    //    Gmail routes ALL image requests through its GoogleImageProxy — both at
    //    delivery time AND when a human opens the email. We cannot filter ALL
    //    GoogleImageProxy requests or we lose every real open. Instead, we only
    //    suppress proxy hits that arrive within GMAIL_PROXY_WINDOW_MS of the
    //    email being registered (those represent Gmail's delivery-time cache
    //    fetch). Proxy hits after that window are treated as real human opens
    //    because our no-cache headers force Gmail to re-fetch on each open.
    //
    // 2. Sender self-view (same IP): the sender opening the email in their
    //    Sent folder from the same network should not count as a recipient open.
    //    The sidebar handles the cross-network case via DELETE .../views/latest.
    const GMAIL_PROXY_WINDOW_MS = 10_000; // 10 seconds — covers Gmail's delivery-time cache fetch
    const isGmailProxy = /GoogleImageProxy/i.test(userAgent ?? "");
    const ageMs = Date.now() - email.createdAt.getTime();
    const isDeliveryTimeProxyFetch = isGmailProxy && ageMs < GMAIL_PROXY_WINDOW_MS;
    const isSenderPeek = !!email.senderIp && !!ip && email.senderIp === ip;

    if (!isDeliveryTimeProxyFetch && !isSenderPeek) {
      // Fire-and-forget so we never hold up the pixel response.
      db.insert(trackedEmailViews)
        .values({
          id: newId(),
          emailId: id,
          ipAddress: ip,
          userAgent,
        })
        .catch((err) => {
          req.log.error(
            { err, emailId: id },
            "tracked_email_views insert failed",
          );
        });
    }

    res.status(200).set(PIXEL_HEADERS).send(PIXEL);
  }),
);

// ─── Extension-facing endpoints (unauthenticated) ──────────────────────────
router.post(
  "/email-tracking",
  asyncHandler(async (req, res) => {
    const parsed = CreateTrackedEmailBodyZ.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Invalid tracked-email body",
        details: parsed.error.flatten(),
      });
      return;
    }
    const senderIp = getRequestIp(req);
    const recipients = parseRecipients(parsed.data.recipient);
    const links = await resolveLinks(recipients);

    const [row] = await db
      .insert(trackedEmails)
      .values({
        id: newId(),
        subject: parsed.data.subject,
        recipient: parsed.data.recipient,
        sender: parsed.data.sender.trim().toLowerCase(),
        senderIp,
        recipientPersonIds: links.personIds,
        recipientFunderIds: links.funderIds,
        recipientHouseholdIds: links.householdIds,
      })
      .returning();

    res.status(201).json({
      id: row.id,
      subject: row.subject,
      recipient: row.recipient,
      sender: row.sender,
      senderIp: row.senderIp,
      recipientPersonIds: row.recipientPersonIds,
      recipientFunderIds: row.recipientFunderIds,
      recipientHouseholdIds: row.recipientHouseholdIds,
      createdAt: row.createdAt.toISOString(),
    });
  }),
);

// ─── Per-recipient (group) send (extension-token authed) ───────────────────
//
// The extension routes a multi-recipient, attachment-free tracked send here.
// We deliver one individualized copy per recipient through the sender's own
// Gmail, each carrying a unique pixel but showing the full To/Cc group, then
// record one tracked_emails row per recipient sharing a group_id + Gmail thread.
router.post(
  "/email-tracking/send",
  requireExtensionToken,
  asyncHandler(async (req, res) => {
    const parsed = SendTrackedEmailBodyZ.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "validation_error",
        message: "Invalid send body",
        details: parsed.error.flatten(),
      });
      return;
    }
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized", message: "No user" });
      return;
    }
    const grant = await getValidGoogleAccessTokenForUser(user.id);
    if (!grant) {
      res.status(409).json({
        error: "google_not_connected",
        message: "Google account not connected. Reconnect in Settings.",
      });
      return;
    }
    if (!grant.scope.split(/\s+/).includes(GMAIL_SEND_SCOPE)) {
      res.status(409).json({
        error: "send_scope_missing",
        message:
          "Gmail send permission not granted. Reconnect Google in Settings.",
      });
      return;
    }

    const to = parsed.data.to.map((s) => s.trim()).filter(Boolean);
    const cc = (parsed.data.cc ?? []).map((s) => s.trim()).filter(Boolean);
    // One row (and one copy) per distinct address across To+Cc.
    const seen = new Set<string>();
    const recipients: string[] = [];
    for (const a of [...to, ...cc]) {
      const lc = a.toLowerCase();
      if (lc.includes("@") && !seen.has(lc)) {
        seen.add(lc);
        recipients.push(lc);
      }
    }
    if (recipients.length === 0) {
      res.status(400).json({
        error: "validation_error",
        message: "No valid recipient addresses.",
      });
      return;
    }

    const groupId = newId();
    const sender = grant.googleEmail.trim().toLowerCase();
    const out: { id: string; recipient: string }[] = [];
    // Gmail returns a threadId only after the first send; reuse it so the
    // sender's Sent folder collapses the copies into one conversation.
    let sharedThreadId: string | null = null;

    for (const recipient of recipients) {
      const pixelId = newId();
      const links = await resolveLinks([recipient]);
      const raw = buildRawMessage({
        from: { email: sender },
        to,
        cc: cc.length ? cc : undefined,
        subject: parsed.data.subject,
        html: injectPixel(parsed.data.html, pixelId),
        inReplyTo: parsed.data.inReplyTo ?? null,
        references: parsed.data.references ?? null,
      });
      let sent;
      try {
        sent = await sendRawMessage(grant.accessToken, raw, sharedThreadId);
      } catch (err) {
        const status = err instanceof GmailSendError ? err.status : 0;
        req.log.error(
          { err, groupId, recipient, sentSoFar: out.length },
          "tracked group send failed",
        );
        res.status(502).json({
          error: "gmail_send_failed",
          message: "Gmail send failed.",
          details: { status, sent: out },
        });
        return;
      }
      if (!sharedThreadId) sharedThreadId = sent.threadId;
      await db.insert(trackedEmails).values({
        id: pixelId,
        subject: parsed.data.subject,
        recipient,
        sender,
        senderIp: null,
        groupId,
        gmailMessageId: sent.id,
        gmailThreadId: sent.threadId,
        recipientPersonIds: links.personIds,
        recipientFunderIds: links.funderIds,
        recipientHouseholdIds: links.householdIds,
      });
      out.push({ id: pixelId, recipient });
    }

    res
      .status(201)
      .json({ groupId, threadId: sharedThreadId, recipients: out });
  }),
);

router.get(
  "/email-tracking/search",
  asyncHandler(async (req, res) => {
    const subject = String(req.query.subject ?? "").trim();
    if (!subject) {
      res.status(400).json({
        error: "validation_error",
        message: "subject query param required",
      });
      return;
    }
    // Magio's extension passes the exact subject; matching exactly is
    // both faster and closer to upstream semantics. Newest first so
    // re-tracking the same thread surfaces the most recent send.
    const email = await db
      .select()
      .from(trackedEmails)
      .where(eq(trackedEmails.subject, subject))
      .orderBy(desc(trackedEmails.createdAt))
      .limit(1)
      .then((r) => r[0]);
    if (!email) {
      res.json(null);
      return;
    }
    res.json(await shapeGroupWithViews(email));
  }),
);

router.get(
  "/email-tracking/status",
  asyncHandler(async (_req, res) => {
    const rows = await db
      .select({
        subject: trackedEmails.subject,
        viewCount: sql<number>`COUNT(${trackedEmailViews.id})::int`,
      })
      .from(trackedEmails)
      .leftJoin(
        trackedEmailViews,
        eq(trackedEmailViews.emailId, trackedEmails.id),
      )
      .groupBy(trackedEmails.id, trackedEmails.subject);
    res.json(rows);
  }),
);

router.delete(
  "/email-tracking/:id/views/latest",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const since = new Date(Date.now() - SENDER_PEEK_WINDOW_MS);
    const deleted = await db
      .delete(trackedEmailViews)
      .where(
        and(
          eq(trackedEmailViews.emailId, id),
          gte(trackedEmailViews.viewedAt, since),
        ),
      )
      .returning({ id: trackedEmailViews.id });
    res.json({ deleted: deleted.length });
  }),
);

// ─── CRM-facing endpoints (auth required) ──────────────────────────────────
router.get(
  "/email-tracking",
  requireAuth,
  asyncHandler(async (req, res) => {
    const limit = Math.min(
      Math.max(Number(req.query.limit ?? 100) || 100, 1),
      1000,
    );
    const rows = await db
      .select({
        id: trackedEmails.id,
        subject: trackedEmails.subject,
        recipient: trackedEmails.recipient,
        sender: trackedEmails.sender,
        senderIp: trackedEmails.senderIp,
        recipientPersonIds: trackedEmails.recipientPersonIds,
        recipientFunderIds: trackedEmails.recipientFunderIds,
        recipientHouseholdIds: trackedEmails.recipientHouseholdIds,
        createdAt: trackedEmails.createdAt,
        totalViews: sql<number>`COUNT(${trackedEmailViews.id})::int`,
        lastView: sql<Date | null>`MAX(${trackedEmailViews.viewedAt})`,
      })
      .from(trackedEmails)
      .leftJoin(
        trackedEmailViews,
        eq(trackedEmailViews.emailId, trackedEmails.id),
      )
      .groupBy(trackedEmails.id)
      .orderBy(desc(trackedEmails.createdAt))
      .limit(limit);

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        subject: r.subject,
        recipient: r.recipient,
        sender: r.sender,
        senderIp: r.senderIp,
        recipientPersonIds: r.recipientPersonIds,
        recipientFunderIds: r.recipientFunderIds,
        recipientHouseholdIds: r.recipientHouseholdIds,
        createdAt: r.createdAt.toISOString(),
        totalViews: r.totalViews ?? 0,
        lastView: r.lastView ? new Date(r.lastView).toISOString() : null,
      })),
    });
  }),
);

router.get(
  "/email-tracking/by-contact",
  requireAuth,
  asyncHandler(async (req, res) => {
    const personId =
      typeof req.query.personId === "string" ? req.query.personId : undefined;
    const funderId =
      typeof req.query.funderId === "string" ? req.query.funderId : undefined;
    const householdId =
      typeof req.query.householdId === "string"
        ? req.query.householdId
        : undefined;
    const presentCount = [personId, funderId, householdId].filter(
      (x) => !!x,
    ).length;
    if (presentCount !== 1) {
      res.status(400).json({
        error: "validation_error",
        message:
          "Exactly one of personId, funderId, householdId is required.",
      });
      return;
    }
    const whereExpr = personId
      ? sql`${trackedEmails.recipientPersonIds} @> ARRAY[${personId}]::text[]`
      : funderId
        ? sql`${trackedEmails.recipientFunderIds} @> ARRAY[${funderId}]::text[]`
        : sql`${trackedEmails.recipientHouseholdIds} @> ARRAY[${householdId}]::text[]`;

    const rows = await db
      .select({
        id: trackedEmails.id,
        subject: trackedEmails.subject,
        recipient: trackedEmails.recipient,
        sender: trackedEmails.sender,
        senderIp: trackedEmails.senderIp,
        recipientPersonIds: trackedEmails.recipientPersonIds,
        recipientFunderIds: trackedEmails.recipientFunderIds,
        recipientHouseholdIds: trackedEmails.recipientHouseholdIds,
        createdAt: trackedEmails.createdAt,
        totalViews: sql<number>`COUNT(${trackedEmailViews.id})::int`,
        lastView: sql<Date | null>`MAX(${trackedEmailViews.viewedAt})`,
      })
      .from(trackedEmails)
      .leftJoin(
        trackedEmailViews,
        eq(trackedEmailViews.emailId, trackedEmails.id),
      )
      .where(whereExpr)
      .groupBy(trackedEmails.id)
      .orderBy(desc(trackedEmails.createdAt));

    res.json({
      data: rows.map((r) => ({
        id: r.id,
        subject: r.subject,
        recipient: r.recipient,
        sender: r.sender,
        senderIp: r.senderIp,
        recipientPersonIds: r.recipientPersonIds,
        recipientFunderIds: r.recipientFunderIds,
        recipientHouseholdIds: r.recipientHouseholdIds,
        createdAt: r.createdAt.toISOString(),
        totalViews: r.totalViews ?? 0,
        lastView: r.lastView ? r.lastView.toISOString() : null,
      })),
    });
  }),
);

// ─── Extension-token management (auth required) ────────────────────────────
// The user generates a token here, then pastes it into the tracking extension
// so the extension can authenticate the per-recipient send endpoint.
router.get(
  "/email-tracking/extension-token",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    res.json({ token: user?.extensionToken ?? null });
  }),
);

router.post(
  "/email-tracking/extension-token",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "unauthorized", message: "No user" });
      return;
    }
    const token = `wft_${randomBytes(24).toString("base64url")}`;
    await db
      .update(users)
      .set({ extensionToken: token })
      .where(eq(users.id, user.id));
    res.json({ token });
  }),
);

router.get(
  "/email-tracking/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const email = await db
      .select()
      .from(trackedEmails)
      .where(eq(trackedEmails.id, id))
      .then((r) => r[0]);
    if (!email) return notFound(res, "tracked email");
    res.json(await shapeGroupWithViews(email));
  }),
);

export default router;
