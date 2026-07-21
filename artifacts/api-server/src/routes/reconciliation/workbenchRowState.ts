/**
 * Canonical row-level state for a reconciliation workbench cluster.
 * Defined in docs/workbench-business-rules.md §10 — never diverge from that spec.
 *
 * Option C migration pattern: compute this canonical state first in each cluster
 * hydration path, then derive legacy coverage fields (including coverage.complete)
 * from it. Do not maintain two independent derivations.
 */

export type LinkCompleteness =
  | "complete"
  | "partial"
  | "mixed"
  | "partial_mixed"
  | "missing";

export type InformationCompleteness =
  | "audit_ready"
  | "accounting_pending"
  | "incomplete";

/** Pairwise coverage between two of the three columns: accounting↔transaction, transaction↔CRM, accounting↔CRM. */
export type CoverageState = {
  state: "missing" | "partial" | "complete" | "mixed";
  grain: "unit" | "bundle" | "mixed" | "none";
  relationshipCount: number;
};

/**
 * Canonical per-transaction card state (docs/workbench-business-rules.md §5.1).
 * refund_anticipated / refunded / excluded apply to the individual transaction
 * only and never bleed into row-level flags.
 */
export type TransactionCardState =
  | "unmatched"
  | "partial"
  | "amount_mismatch"
  | "info_conflict"
  | "matched"
  | "refund_anticipated"
  | "refunded"
  | "excluded";

export type TransactionEntry = {
  transactionId: string;
  livePayment: boolean;
  refundStatus: "none" | "anticipated" | "refunded";
  state: TransactionCardState;
};

export type QbCardState =
  | "raw"
  | "enriched"
  | "match_proposed"
  | "matched_complete"
  | "matched_partial_qb_surplus"
  | "matched_partial_external_surplus"
  | "matched_conflict"
  | "excluded";

export type QbCardEntry = {
  qbRecordId: string;
  state: QbCardState;
  /** True only for qb_standalone clusters where the QB record IS the transaction evidence. */
  isTransactionEvidence: boolean;
};

/**
 * The ONE mapping from a QB staged row's derived linkage status
 * (pending/match_proposed/match_confirmed/excluded) to its canonical card
 * state. coverage.state.qbCards is the only place per-record QB status is
 * carried on the wire — WorkbenchClusterQbRecord no longer has a status field.
 * "enriched" is reserved for the future fill-out-QB documentation workflow
 * and is never derived from linkage status.
 */
export function qbCardStateOfStatus(status: string | null | undefined): QbCardState {
  switch (status) {
    case "match_confirmed":
      return "matched_complete";
    case "match_proposed":
      return "match_proposed";
    case "excluded":
      return "excluded";
    default:
      return "raw";
  }
}

export type CrmCardState =
  | "missing"
  | "unmatched_incomplete"
  | "unmatched_complete"
  | "matched_incomplete"
  | "matched_complete"
  | "partial_gift_surplus"
  | "partial_external_surplus"
  | "mixed"
  | "conflict"
  | "pledge_link_broken"
  | "lost"
  | "dormant";

/** Canonical satisfiedBy vocabulary — renames the legacy API field names. */
export type CrmSatisfiedByCanonical =
  | "donorbox"
  | "completed_coding_form"
  | "donor_allocations_and_supporting_documents"
  | null;

export type CrmCardEntry = {
  giftId: string;
  recordComplete: boolean;
  state: CrmCardState;
  satisfiedBy: CrmSatisfiedByCanonical;
};

export type SettlementLinkState =
  | "unlinked"
  | "proposed_full"
  | "proposed_partial"
  | "proposed_conflict"
  | "confirmed";

/**
 * Canonical row-level state per docs/workbench-business-rules.md §10.
 * Every field is derived once from authoritative DB/hydration data and used
 * for both lens routing and UI rendering. Never store or recompute separately.
 */
export type WorkbenchRowState = {
  linkage: {
    /** End-to-end chain completeness across all three columns. */
    state: LinkCompleteness;
    /** QB ↔ Stripe: does the accounting record know about the transaction? */
    accountingToTransaction: CoverageState;
    /** Stripe ↔ CRM: does the transaction link to a CRM gift? */
    transactionToCrm: CoverageState;
    /** QB ↔ CRM: direct accounting-to-CRM link (deposit-grain PAs; missing for charge-tie path). */
    accountingToCrm: CoverageState;
  };
  information: {
    /** Content completeness of the records involved. */
    state: InformationCompleteness;
    /** True when all linked CRM gift records satisfy the record-completeness predicate. */
    crmComplete: boolean;
    /**
     * QB DOCUMENTATION completeness — finance has filled out the QB record from
     * CRM (the fill-out-QB workflow). Gates audit_ready. Always false until that
     * workflow ships (see QB_DOCUMENTATION_COMPLETE).
     */
    qbComplete: boolean;
    /** True when the accounting evidence is present and settled (evidence linkage only). */
    qbEvidenceComplete: boolean;
  };
  flags: {
    /** True when all non-zero charges/records in the cluster are excluded from counts. */
    excluded: boolean;
    /** True when a proposed settlement link conflicts with an already-approved gift. */
    conflict: boolean;
    /** True when any non-excluded charge has a pending refund/chargeback proposal. */
    attentionRequired: boolean;
  };
  /** Present only for stripe_payout clusters that have a settlement link entry. */
  settlementLinkState?: SettlementLinkState;
  /** One card per QB evidence record. Empty for crm_only. */
  qbCards: QbCardEntry[];
  /** One entry per countable transaction unit. Empty for crm_only. */
  transactions: TransactionEntry[];
  /** One card per CRM gift in the cluster. */
  crmCards: CrmCardEntry[];
};

/**
 * QB DOCUMENTATION predicate — the fill-out-QB workflow does not exist yet, so
 * no row can be documentation-complete. ONE authority for both the TS
 * derivation (information.qbComplete) and the slim SQL f_completed arm
 * (QB_DOCUMENTATION_COMPLETE_SQL). When the fill-out-QB workflow ships, both
 * must change in lockstep to the real documentation state.
 */
export const QB_DOCUMENTATION_COMPLETE = false;
export const QB_DOCUMENTATION_COMPLETE_SQL = "false";

/**
 * The ONE information-state derivation (§10): CRM content first, then
 * accounting. audit_ready requires the DOCUMENTATION predicate (qbDocumented),
 * not merely linked/settled evidence — evidence-linked-but-undocumented rows
 * stay accounting_pending until the fill-out-QB workflow exists.
 */
export function informationStateOf(args: {
  crmComplete: boolean;
  qbEvidenceComplete: boolean;
  qbDocumented: boolean;
  attentionRequired: boolean;
}): InformationCompleteness {
  if (!args.crmComplete) return "incomplete";
  if (!args.qbEvidenceComplete || !args.qbDocumented || args.attentionRequired) {
    return "accounting_pending";
  }
  return "audit_ready";
}

/** Row-level completion classification — the one definition Completed uses. */
export function rowCompleteFromState(s: WorkbenchRowState): boolean {
  return s.linkage.state === "complete" && s.information.state === "audit_ready";
}

/**
 * Lens-relevant flags derived from the canonical state. The slim SQL f_* flags
 * in buildUniverse() are a performance twin of THIS derivation — the
 * integration parity test asserts they agree for every returned row.
 */
export function lensFlagsFromState(s: WorkbenchRowState): {
  completed: boolean;
  excluded: boolean;
  conflicts: boolean;
  refunds: boolean;
  attention_required: boolean;
} {
  return {
    completed: rowCompleteFromState(s),
    excluded: s.flags.excluded,
    conflicts: s.flags.conflict,
    refunds: s.transactions.some((t) => t.state === "refund_anticipated"),
    attention_required: s.flags.attentionRequired,
  };
}
