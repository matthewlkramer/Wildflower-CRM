import type { AirtableRecord } from "./airtableClient";
import type { FlodeskSubscriber } from "./flodeskClient";

export const FILLOUT_COMMUNICATIONS_QUESTION =
  "Finally, are you interested in receiving communications and updates from Wildflower?";
const EMAIL_QUESTION = "Thanks,  . And, what's your Email?";
export const SSJ_CONSENT_FIELDS = [
  "Email",
  "Receive Communications",
  "Entry Date",
  "Record Disposition",
  "Submission Integrity Issue",
  "Fillout Submission ID",
  "Raw Fillout Source Snapshot",
  "JSONB of Start a School Form",
];
export const RAW_CONSENT_FIELDS = [
  "Submission ID",
  "Last updated",
  EMAIL_QUESTION,
  FILLOUT_COMMUNICATIONS_QUESTION,
  "Record Disposition",
  "Raw Integrity Issue",
];
export type ConsentEvidence = {
  email: string;
  eventType: "consent_given" | "opted_out" | "legacy_selected";
  occurredAt: Date | null;
  source: string;
  sourceKey: string;
  sourceUrl?: string;
  evidence: string;
  metadata: Record<string, unknown>;
};
export function sourceText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && "name" in value)
    return sourceText(value.name);
  return "";
}
function sourceDate(value: unknown): Date | null {
  const text = sourceText(value);
  // Require an explicit calendar date; avoid locale-dependent date parsing.
  if (!/^\d{4}-\d{2}-\d{2}/.test(text)) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) && date.getTime() <= Date.now()
    ? date
    : null;
}
function jsonFields(value: unknown): Record<string, unknown> | null {
  try {
    const object = JSON.parse(sourceText(value));
    if (!object || typeof object !== "object" || Array.isArray(object))
      return null;
    return object.fields ?? object;
  } catch {
    return null;
  }
}

/** Exact answer parsing only. Blank/ambiguous text never becomes consent.
 * SSJ normalized values must agree with their preserved original answer. */
export function filloutConsentEvidence(
  record: AirtableRecord,
  normalized: boolean,
): ConsentEvidence | null {
  const f = record.fields;
  if (
    sourceText(f["Record Disposition"]) ||
    sourceText(
      f[normalized ? "Submission Integrity Issue" : "Raw Integrity Issue"],
    )
  )
    return null;
  const original = normalized
    ? (jsonFields(f["Raw Fillout Source Snapshot"]) ??
      jsonFields(f["JSONB of Start a School Form"]))
    : f;
  if (!original) return null;
  const originalAnswer = sourceText(
    original[FILLOUT_COMMUNICATIONS_QUESTION] ??
      original["Receive Communications"],
  ).toLowerCase();
  const answer = normalized
    ? sourceText(f["Receive Communications"]).toLowerCase()
    : originalAnswer;
  if (answer !== originalAnswer || !["yes", "no"].includes(answer)) return null;
  const email = sourceText(
    normalized ? f.Email : f[EMAIL_QUESTION],
  ).toLowerCase();
  const originalEmail = sourceText(
    original[EMAIL_QUESTION] ?? original.Email,
  ).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || originalEmail !== email)
    return null;
  // A record-update timestamp is not a response timestamp. Preserve undated
  // consent without giving it the ability to supersede a known opt-out.
  const occurredAt = sourceDate(original["Entry Date"]);
  const normalizedDate = sourceDate(f["Entry Date"]);
  if (
    normalized &&
    occurredAt &&
    normalizedDate &&
    Math.abs(occurredAt.getTime() - normalizedDate.getTime()) >= 60_000
  )
    return null;
  const providerId = sourceText(
    f[normalized ? "Fillout Submission ID" : "Submission ID"],
  );
  const tableId = normalized ? "tblvgyMdMcidh8k6u" : "tbls7U2BOBRQrfQTy";
  return {
    email,
    eventType: answer === "yes" ? "consent_given" : "opted_out",
    occurredAt,
    source: "Fillout / School Startup Journey",
    sourceKey: providerId
      ? `fillout:${providerId}`
      : `ssj-airtable:${record.id}`,
    sourceUrl: `https://airtable.com/appJBT9a4f3b7hWQ2/${tableId}/${record.id}`,
    evidence: `${FILLOUT_COMMUNICATIONS_QUESTION} Answer: ${answer === "yes" ? "Yes" : "No"}. Original response preserved in the source record.`,
    metadata: {
      submissionId: providerId || null,
      sourceRecordId: record.id,
      sourceTableId: tableId,
      dateSource: occurredAt ? "Preserved form Entry Date" : "Unknown",
      sourceUpdatedAt: sourceText(original["Last updated"]) || null,
      normalizedEmail: email,
    },
  };
}

export function flodeskConsentEvidence(
  subscriber: FlodeskSubscriber,
): ConsentEvidence[] {
  const email = subscriber.email.trim().toLowerCase();
  const id = subscriber.id ?? email;
  const events: ConsentEvidence[] = [];
  const optin = sourceDate(subscriber.optinTimestamp);
  if (optin)
    events.push({
      email,
      eventType: "consent_given",
      occurredAt: optin,
      source: "Flodesk",
      sourceKey: `flodesk:optin:${id}:${optin.toISOString()}`,
      evidence: "Affirmative opt-in timestamp supplied by Flodesk.",
      metadata: {
        subscriberId: subscriber.id ?? null,
        providerSource: subscriber.source ?? null,
        normalizedEmail: email,
      },
    });
  if (subscriber.status === "unsubscribed")
    events.push({
      email,
      eventType: "opted_out",
      occurredAt: null,
      source: "Flodesk",
      sourceKey: `flodesk:unsubscribe:${id}:${optin?.toISOString() ?? "unknown"}`,
      evidence:
        "Flodesk reports unsubscribed. The subscriber API does not supply the original unsubscribe date or initiator.",
      metadata: {
        subscriberId: subscriber.id ?? null,
        normalizedEmail: email,
        providerStatus: subscriber.status,
      },
    });
  else if (subscriber.status === "active" && !optin)
    events.push({
      email,
      eventType: "legacy_selected",
      occurredAt: null,
      source: "Flodesk",
      sourceKey: `flodesk:membership:${id}`,
      evidence:
        "Existing Flodesk audience membership; no affirmative opt-in timestamp supplied. This is not proof of consent.",
      metadata: {
        subscriberId: subscriber.id ?? null,
        normalizedEmail: email,
        providerSource: subscriber.source ?? null,
      },
    });
  return events;
}
