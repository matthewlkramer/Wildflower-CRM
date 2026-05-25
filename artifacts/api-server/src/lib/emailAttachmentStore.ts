import { objectStorageClient } from "./objectStorage";

/**
 * Write Gmail attachment bytes to GCS using the Replit-sidecar-
 * authenticated client copied from the object-storage skill. We
 * use the raw GCS client directly (rather than the skill's
 * presigned-URL flow) because the bytes flow server-to-server —
 * there's no browser in the path.
 *
 * Storage layout under PRIVATE_OBJECT_DIR:
 *
 *   email-attachments/<userId>/<gmailMessageId>/<attachmentId>-<filename>
 *
 * The userId scope keeps mailboxes isolated for the (eventual) ACL
 * check; gmailMessageId scope makes "delete one message" a single
 * prefix sweep; attachmentId prefix avoids filename collisions
 * within a message.
 *
 * Returns the *full* GCS object name (including the prefix
 * portion of PRIVATE_OBJECT_DIR), not a path relative to
 * PRIVATE_OBJECT_DIR. T005's download route should resolve this by
 * calling `objectStorageClient.bucket(<parsedBucket>).file(storage_key)`
 * directly, NOT via `ObjectStorageService.getObjectEntityFile` —
 * that helper expects "/objects/<id>" inputs and would double-
 * prefix PRIVATE_OBJECT_DIR.
 */

interface PrivateDir {
  bucket: string;
  prefix: string;
}

function parsePrivateDir(): PrivateDir {
  const raw = process.env["PRIVATE_OBJECT_DIR"];
  if (!raw) {
    throw new Error(
      "PRIVATE_OBJECT_DIR is not set; object storage has not been provisioned",
    );
  }
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  const slash = trimmed.indexOf("/");
  if (slash < 0) {
    // Bucket-only — no prefix. Unusual but valid.
    return { bucket: trimmed, prefix: "" };
  }
  return {
    bucket: trimmed.slice(0, slash),
    prefix: trimmed.slice(slash + 1),
  };
}

function safeFilename(name: string): string {
  // GCS object names allow most characters but we strip path-y
  // chars to keep the on-disk-ish layout sane and prevent any
  // accidental traversal in downstream consumers.
  return name.replace(/[\\/\0\r\n]/g, "_").slice(0, 200);
}

export interface AttachmentUploadInput {
  userId: string;
  gmailMessageId: string;
  gmailAttachmentId: string;
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

export async function uploadAttachment(
  input: AttachmentUploadInput,
): Promise<string> {
  const { bucket, prefix } = parsePrivateDir();
  const objectName = [
    prefix,
    "email-attachments",
    input.userId,
    input.gmailMessageId,
    `${input.gmailAttachmentId}-${safeFilename(input.filename)}`,
  ]
    .filter(Boolean)
    .join("/");
  await objectStorageClient
    .bucket(bucket)
    .file(objectName)
    .save(input.bytes, {
      contentType: input.mimeType || "application/octet-stream",
      resumable: false,
      metadata: {
        contentType: input.mimeType || "application/octet-stream",
        metadata: {
          gmailMessageId: input.gmailMessageId,
          gmailAttachmentId: input.gmailAttachmentId,
          originalFilename: input.filename,
        },
      },
    });
  return objectName;
}
