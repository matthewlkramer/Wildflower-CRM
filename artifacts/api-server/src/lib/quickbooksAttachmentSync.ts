import { db } from "@workspace/db";
import {
  bankDepositComponents,
  paymentUnits,
  quickbooksDepositAttachments,
  sourceLinks,
  stagedPayments,
} from "@workspace/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { newId } from "./helpers";
import { logger } from "./logger";
import {
  downloadQuickbooksAttachment,
  pullDepositAttachments,
  pullDepositsForAttachments,
  type NormalizedQuickbooksPayment,
  type QuickbooksDepositAttachment,
  type QuickbooksDepositForAttachment,
} from "./quickbooksClient";
import {
  extractDepositAttachmentComposition,
  validateAttachmentComposition,
  type ExtractedDepositComponent,
} from "./quickbooksAttachmentComposition";

function mimeFromName(fileName: string | null): string | null {
  const name = fileName?.toLowerCase() ?? "";
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".webp")) return "image/webp";
  return null;
}

function dateValue(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameTimestamp(left: Date | null, right: string | null): boolean {
  const parsed = dateValue(right);
  if (!left && !parsed) return true;
  return left?.getTime() === parsed?.getTime();
}

function hasLinkedIncomingMoney(
  deposit: QuickbooksDepositForAttachment,
): boolean {
  if (!deposit.raw || typeof deposit.raw !== "object") return false;
  const lines = (deposit.raw as { Line?: unknown }).Line;
  if (!Array.isArray(lines)) return false;
  return lines.some((line) => {
    if (!line || typeof line !== "object") return false;
    const linked = (line as { LinkedTxn?: unknown }).LinkedTxn;
    return (
      Array.isArray(linked) &&
      linked.some((txn) => {
        if (!txn || typeof txn !== "object") return false;
        const type = (txn as { TxnType?: unknown }).TxnType;
        return type === "Payment" || type === "SalesReceipt";
      })
    );
  });
}

function compositionKey(components: ExtractedDepositComponent[]): string {
  return JSON.stringify(
    components.map((component) => ({
      amount: component.amount,
      payerName: component.payerName,
      checkNumber: component.checkNumber,
      reference: component.reference,
    })),
  );
}

async function extractOrLoadAttachment(args: {
  accessToken: string;
  realmId: string;
  attachment: QuickbooksDepositAttachment;
  depositTotal: string;
  existing: typeof quickbooksDepositAttachments.$inferSelect | undefined;
}): Promise<ExtractedDepositComponent[] | null> {
  const { accessToken, realmId, attachment, depositTotal, existing } = args;
  const unchanged =
    existing && sameTimestamp(existing.qbUpdatedAt, attachment.updatedAt);
  if (unchanged && existing.extractionStatus === "extracted") {
    return validateAttachmentComposition(depositTotal, existing.components);
  }
  if (unchanged && existing.extractionStatus === "ignored") return null;

  const now = new Date();
  const baseValues = {
    realmId,
    qbAttachableId: attachment.id,
    qbDepositId: attachment.depositId,
    fileName: attachment.fileName,
    contentType: attachment.contentType,
    note: attachment.note,
    qbUpdatedAt: dateValue(attachment.updatedAt),
    updatedAt: now,
  };

  try {
    const hintedMime =
      attachment.contentType?.split(";", 1)[0]?.trim() ||
      mimeFromName(attachment.fileName);
    if (
      !hintedMime ||
      !/^(application\/pdf|image\/(?:jpeg|png|gif|webp))$/i.test(hintedMime)
    ) {
      await db
        .insert(quickbooksDepositAttachments)
        .values({
          id: existing?.id ?? newId(),
          ...baseValues,
          extractionStatus: "ignored",
          components: null,
          extractionError: "Unsupported attachment type",
          extractedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            quickbooksDepositAttachments.realmId,
            quickbooksDepositAttachments.qbAttachableId,
            quickbooksDepositAttachments.qbDepositId,
          ],
          set: {
            ...baseValues,
            extractionStatus: "ignored",
            components: null,
            extractionError: "Unsupported attachment type",
            extractedAt: now,
          },
        });
      return null;
    }

    const downloaded = await downloadQuickbooksAttachment(
      accessToken,
      attachment.tempDownloadUri,
    );
    const mimeType =
      downloaded.contentType?.split(";", 1)[0]?.trim() || hintedMime;
    const components = await extractDepositAttachmentComposition({
      bytes: downloaded.bytes,
      mimeType,
      fileName: attachment.fileName ?? `deposit-${attachment.depositId}`,
      depositTotal,
    });
    await db
      .insert(quickbooksDepositAttachments)
      .values({
        id: existing?.id ?? newId(),
        ...baseValues,
        contentType: mimeType,
        extractionStatus: components ? "extracted" : "ignored",
        components,
        extractionError: components
          ? null
          : "No exact-sum multi-payment composition found",
        extractedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          quickbooksDepositAttachments.realmId,
          quickbooksDepositAttachments.qbAttachableId,
          quickbooksDepositAttachments.qbDepositId,
        ],
        set: {
          ...baseValues,
          contentType: mimeType,
          extractionStatus: components ? "extracted" : "ignored",
          components,
          extractionError: components
            ? null
            : "No exact-sum multi-payment composition found",
          extractedAt: now,
        },
      });
    return components;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db
      .insert(quickbooksDepositAttachments)
      .values({
        id: existing?.id ?? newId(),
        ...baseValues,
        extractionStatus: "error",
        components: null,
        extractionError: message.slice(0, 1000),
        extractedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          quickbooksDepositAttachments.realmId,
          quickbooksDepositAttachments.qbAttachableId,
          quickbooksDepositAttachments.qbDepositId,
        ],
        set: {
          ...baseValues,
          extractionStatus: "error",
          components: null,
          extractionError: message.slice(0, 1000),
          extractedAt: now,
        },
      });
    logger.warn(
      {
        err: error,
        attachmentId: attachment.id,
        depositId: attachment.depositId,
      },
      "QuickBooks deposit attachment could not be extracted",
    );
    return null;
  }
}

/**
 * Replace only stale, untouched QBO deposit-line evidence. Any human review,
 * gift tie, non-QBO component, split, or cross-source claim makes the deposit
 * ineligible for automatic replacement.
 */
async function removeReplaceableStagedRows(args: {
  realmId: string;
  depositId: string;
  keepLineIds: string[];
}): Promise<boolean> {
  return db.transaction(async (tx) => {
    const existingRows = await tx
      .select()
      .from(stagedPayments)
      .where(
        and(
          eq(stagedPayments.realmId, args.realmId),
          eq(stagedPayments.qbEntityId, args.depositId),
          inArray(stagedPayments.qbEntityType, ["deposit", "deposit_header"]),
        ),
      )
      .for("update");
    if (existingRows.length === 0) return true;

    const existingIds = existingRows.map((row) => row.id);
    const stale = existingRows.filter(
      (row) =>
        row.qbEntityType === "deposit_header" ||
        !args.keepLineIds.includes(row.qbLineId),
    );

    if (
      existingRows.some(
        (row) =>
          row.classificationSource === "manual" ||
          row.entitySource === "manual" ||
          row.fundingSourceProvenance === "manual" ||
          row.matchConfirmedAt !== null ||
          row.approvedAt !== null ||
          row.autoApplied,
      )
    ) {
      return false;
    }

    const [children, links, units, components] = await Promise.all([
      tx
        .select({ id: stagedPayments.id })
        .from(stagedPayments)
        .where(inArray(stagedPayments.splitParentId, existingIds)),
      tx
        .select()
        .from(sourceLinks)
        .where(inArray(sourceLinks.qbStagedPaymentId, existingIds)),
      tx
        .select()
        .from(paymentUnits)
        .where(inArray(paymentUnits.sourceStagedPaymentId, existingIds)),
      tx
        .select()
        .from(bankDepositComponents)
        .where(
          inArray(bankDepositComponents.sourceStagedPaymentId, existingIds),
        ),
    ]);
    const unitIds = units.map((unit) => unit.id);
    const unitLinks = unitIds.length
      ? await tx
          .select({ id: sourceLinks.id })
          .from(sourceLinks)
          .where(inArray(sourceLinks.paymentUnitId, unitIds))
      : [];
    const protectedEvidence =
      children.length > 0 ||
      links.some((link) => link.linkType !== "qbo_line_deposit") ||
      units.some((unit) => unit.giftId !== null) ||
      unitLinks.length > 0 ||
      components.some(
        (component) =>
          component.source !== "qbo_inferred" ||
          component.classificationSource === "manual",
      );
    if (protectedEvidence) return false;
    if (stale.length === 0) return true;

    const staleIds = stale.map((row) => row.id);
    const staleIdSet = new Set(staleIds);
    const staleLinks = links.filter(
      (link) =>
        link.qbStagedPaymentId !== null &&
        staleIdSet.has(link.qbStagedPaymentId),
    );
    const staleComponents = components.filter(
      (component) =>
        component.sourceStagedPaymentId !== null &&
        staleIdSet.has(component.sourceStagedPaymentId),
    );
    const staleUnits = units.filter(
      (unit) =>
        unit.sourceStagedPaymentId !== null &&
        staleIdSet.has(unit.sourceStagedPaymentId),
    );

    if (staleLinks.length) {
      await tx.delete(sourceLinks).where(
        inArray(
          sourceLinks.id,
          staleLinks.map((link) => link.id),
        ),
      );
    }
    if (staleComponents.length) {
      await tx.delete(bankDepositComponents).where(
        inArray(
          bankDepositComponents.id,
          staleComponents.map((component) => component.id),
        ),
      );
    }
    const staleUnitIds = staleUnits.map((unit) => unit.id);
    if (staleUnitIds.length) {
      await tx
        .delete(paymentUnits)
        .where(inArray(paymentUnits.id, staleUnitIds));
    }
    await tx.delete(stagedPayments).where(inArray(stagedPayments.id, staleIds));
    return true;
  });
}

function toStagedRows(args: {
  attachment: QuickbooksDepositAttachment;
  deposit: QuickbooksDepositForAttachment;
  components: ExtractedDepositComponent[];
}): NormalizedQuickbooksPayment[] {
  return args.components.map((component, index) => ({
    qbEntityType: "deposit",
    qbEntityId: args.deposit.id,
    qbLineId: `attachment:${args.attachment.id}:${index + 1}`,
    qbDepositId: args.deposit.id,
    amount: component.amount,
    dateReceived: args.deposit.txnDate,
    payerName: component.payerName,
    payerEmail: null,
    rawReference: component.checkNumber ?? component.reference,
    lineDescription:
      component.reference ?? args.attachment.note ?? args.deposit.privateNote,
    lastUpdatedTime: args.attachment.updatedAt ?? args.deposit.updatedAt,
    lineItemNames: [],
    lineAccountNames: [],
    lineClasses: [],
    qbPayerType: null,
    qbPayerId: null,
    qbPaymentMethod: component.checkNumber ? "Check" : null,
    qbCheckNumber: component.checkNumber,
    qbDepositToAccountName: args.deposit.depositToAccountName,
    qbDocNumber: null,
    qbBillingAddress: null,
    qbTransactionMemo: args.deposit.privateNote,
    qbLocation: null,
    qbCurrency: args.deposit.currency,
    qbExchangeRate: args.deposit.exchangeRate,
    qbCreateTime: args.deposit.createTime,
    qbLinkedTxn: null,
    qbInvoiceApplications: null,
    qbRaw: args.deposit.raw,
    qbRawLine: {
      source: "quickbooks_attachment",
      attachableId: args.attachment.id,
      fileName: args.attachment.fileName,
      component,
    },
  }));
}

/**
 * Produce exact-sum deposit component rows from new/changed QBO attachments.
 * Conflicting attachment interpretations and deposits with linked QB payments
 * remain unresolved for a human.
 */
export async function prepareAttachmentDepositRows(args: {
  accessToken: string;
  realmId: string;
}): Promise<{
  rows: NormalizedQuickbooksPayment[];
  managedDepositIds: Set<string>;
}> {
  let attachments: QuickbooksDepositAttachment[];
  try {
    attachments = await pullDepositAttachments(args.accessToken, args.realmId);
  } catch (error) {
    logger.warn({ err: error }, "QuickBooks attachment metadata pull failed");
    return { rows: [], managedDepositIds: new Set() };
  }
  if (attachments.length === 0) {
    return { rows: [], managedDepositIds: new Set() };
  }

  const deposits = await pullDepositsForAttachments(
    args.accessToken,
    args.realmId,
    attachments.map((attachment) => attachment.depositId),
  );
  const cached = await db
    .select()
    .from(quickbooksDepositAttachments)
    .where(eq(quickbooksDepositAttachments.realmId, args.realmId));
  const cacheByKey = new Map(
    cached.map((row) => [`${row.qbAttachableId}:${row.qbDepositId}`, row]),
  );
  const grouped = new Map<string, QuickbooksDepositAttachment[]>();
  for (const attachment of attachments) {
    const list = grouped.get(attachment.depositId) ?? [];
    list.push(attachment);
    grouped.set(attachment.depositId, list);
  }

  const rows: NormalizedQuickbooksPayment[] = [];
  const managedDepositIds = new Set<string>();
  for (const [depositId, depositAttachments] of grouped) {
    const deposit = deposits.get(depositId);
    if (!deposit || hasLinkedIncomingMoney(deposit)) continue;

    const candidates: Array<{
      attachment: QuickbooksDepositAttachment;
      components: ExtractedDepositComponent[];
    }> = [];
    for (const attachment of depositAttachments) {
      const components = await extractOrLoadAttachment({
        ...args,
        attachment,
        depositTotal: deposit.totalAmount,
        existing: cacheByKey.get(`${attachment.id}:${attachment.depositId}`),
      });
      if (components) candidates.push({ attachment, components });
    }
    if (candidates.length === 0) continue;

    const interpretations = new Map<string, (typeof candidates)[number]>();
    for (const candidate of candidates) {
      interpretations.set(compositionKey(candidate.components), candidate);
    }
    if (interpretations.size !== 1) {
      logger.warn(
        { depositId, attachmentIds: candidates.map((c) => c.attachment.id) },
        "QuickBooks deposit attachments disagree; composition left unresolved",
      );
      continue;
    }
    const candidate = [...interpretations.values()][0];
    if (!candidate) continue;
    const stagedRows = toStagedRows({ deposit, ...candidate });
    const canReplace = await removeReplaceableStagedRows({
      realmId: args.realmId,
      depositId,
      keepLineIds: stagedRows.map((row) => row.qbLineId),
    });
    // Once an exact attachment composition is known, the base Deposit rows
    // must not be staged beside it. When human-reviewed evidence prevents an
    // automatic refresh, keep that evidence intact and still suppress the
    // duplicate base representation for this sync.
    managedDepositIds.add(depositId);
    if (canReplace) rows.push(...stagedRows);
  }
  return { rows, managedDepositIds };
}
