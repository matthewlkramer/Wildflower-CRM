// Pure validation logic for linking a QuickBooks staged payment to an existing
// gifts_and_payments row (the "link to existing gift" flow, as opposed to the
// "approve → mint a new gift" flow). Kept side-effect-free so it is unit
// testable; the route layer supplies the DB facts (does the row exist, is the
// gift already linked) and applies the result.

export type LinkDonor = {
  organizationId: string | null;
  individualGiverPersonId: string | null;
  householdId: string | null;
};

export type LinkIssue = { code: string; message: string };

/** Normalize a row's three donor FKs into a bare LinkDonor (nulls preserved). */
export function donorOf(row: {
  organizationId?: string | null;
  individualGiverPersonId?: string | null;
  householdId?: string | null;
}): LinkDonor {
  return {
    organizationId: row.organizationId ?? null,
    individualGiverPersonId: row.individualGiverPersonId ?? null,
    householdId: row.householdId ?? null,
  };
}

/** True when exactly one donor FK is set (the gift/staged donor XOR). */
export function hasExactlyOneDonor(d: LinkDonor): boolean {
  const set = [
    d.organizationId,
    d.individualGiverPersonId,
    d.householdId,
  ].filter((v) => v != null);
  return set.length === 1;
}

/** True when both donors point at the same single entity (same type + id). */
export function donorsMatch(a: LinkDonor, b: LinkDonor): boolean {
  return (
    (a.organizationId ?? null) === (b.organizationId ?? null) &&
    (a.individualGiverPersonId ?? null) === (b.individualGiverPersonId ?? null) &&
    (a.householdId ?? null) === (b.householdId ?? null)
  );
}

/**
 * Validate that a staged payment may be linked to a given existing gift.
 * Returns an empty array when the link is allowed; otherwise one or more
 * issues. DB-derived preconditions (row/gift existence, pending status) are
 * checked in the route; this covers the relational invariants.
 */
export function validateGiftLink(args: {
  stagedDonor: LinkDonor;
  giftDonor: LinkDonor;
  /** The staged payment id already linked to this gift, if any. */
  alreadyLinkedStagedPaymentId: string | null;
}): LinkIssue[] {
  const issues: LinkIssue[] = [];

  if (!hasExactlyOneDonor(args.stagedDonor)) {
    issues.push({
      code: "no_donor",
      message: "Set a donor on the staged payment before linking it to a gift.",
    });
  }

  if (args.alreadyLinkedStagedPaymentId) {
    issues.push({
      code: "already_linked",
      message:
        "That gift is already linked to another QuickBooks payment. Pick a different gift.",
    });
  }

  // Only meaningful once the staged row actually has a donor.
  if (
    hasExactlyOneDonor(args.stagedDonor) &&
    !donorsMatch(args.stagedDonor, args.giftDonor)
  ) {
    issues.push({
      code: "donor_mismatch",
      message:
        "The gift's donor does not match the staged payment's donor. Pick a gift for the same donor.",
    });
  }

  return issues;
}
