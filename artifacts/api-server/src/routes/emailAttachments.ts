import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { emailAttachments, emailMessages } from "@workspace/db/schema";
import { and, eq, or } from "drizzle-orm";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import { asyncHandler, notFound, paramId } from "../lib/helpers";
import { objectStorageClient } from "../lib/objectStorage";

/**
 * Stream an email attachment back to the browser. We deliberately
 * don't go through ObjectStorageService.getObjectEntityFile here —
 * the attachment storage_key is the *full* GCS object name
 * including the PRIVATE_OBJECT_DIR prefix (see
 * emailAttachmentStore.ts header), so we resolve it via the raw
 * `bucket.file(...)` API.
 *
 * Authorization: load the attachment's parent message first and
 * apply the same `(is_private=false OR mailbox_user_id=caller)`
 * predicate the email list uses. A non-visible attachment 404s —
 * same shape as a private message a non-owner can't see in the
 * list.
 */

function parsePrivateBucket(): string {
  const raw = process.env["PRIVATE_OBJECT_DIR"];
  if (!raw) throw new Error("PRIVATE_OBJECT_DIR is not set");
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  const slash = trimmed.indexOf("/");
  return slash < 0 ? trimmed : trimmed.slice(0, slash);
}

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/email-attachments/:id/download",
  asyncHandler(async (req, res) => {
    const user = getAppUser(req);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const visibility = or(
      eq(emailMessages.isPrivate, false),
      eq(emailMessages.mailboxUserId, user.id),
    );
    const row = await db
      .select({
        id: emailAttachments.id,
        filename: emailAttachments.filename,
        mimeType: emailAttachments.mimeType,
        sizeBytes: emailAttachments.sizeBytes,
        storageKey: emailAttachments.storageKey,
      })
      .from(emailAttachments)
      .innerJoin(
        emailMessages,
        eq(emailAttachments.emailMessageId, emailMessages.id),
      )
      .where(and(eq(emailAttachments.id, paramId(req)), visibility))
      .then((r) => r[0]);
    if (!row) return notFound(res, "attachment");

    const bucket = parsePrivateBucket();
    const file = objectStorageClient.bucket(bucket).file(row.storageKey);
    res.setHeader("Content-Type", row.mimeType || "application/octet-stream");
    res.setHeader("Content-Length", String(row.sizeBytes));
    // Quote the filename for safety with spaces / commas; fall back
    // to the bare filename for browsers that don't honour the
    // RFC 5987 form. The strip mirrors what we did at upload time
    // in `safeFilename`.
    const safe = (row.filename ?? "attachment").replace(/["\\\r\n]/g, "_");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safe}"`,
    );
    const stream = file.createReadStream();
    stream.on("error", (err) => {
      req.log.error({ err, attachmentId: row.id }, "Attachment stream failed");
      if (!res.headersSent) res.status(500).json({ error: "stream_failed" });
      else res.end();
    });
    stream.pipe(res);
  }),
);

export default router;
