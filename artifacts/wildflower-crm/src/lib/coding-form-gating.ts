/**
 * Cross-check gating for the coding-form import review UI.
 *
 * timeRestriction is override-driven on the server: it only becomes
 * `applicable` once a reviewer override exists (no sheet column carries
 * temporal language). To avoid a chicken-and-egg trap, the UI must offer the
 * override picker — and let the reviewer mark "apply" once they've typed an
 * override — even while the server-computed check still reads not-applicable
 * ("na"). The locally typed override is sent in the same apply request, so
 * the server recomputes the check with it and writes the value.
 */

export interface GatableCrossCheck {
  attribute: string;
  applicable: boolean;
  status: string;
  blockedReason?: string | null;
}

function hasLocalOverride(
  c: GatableCrossCheck,
  overrides: Record<string, string>,
): boolean {
  return (
    c.attribute === "timeRestriction" &&
    !!overrides[c.attribute] &&
    overrides[c.attribute].trim().length > 0
  );
}

/** May the reviewer set an override for this cross-check? */
export function canOverrideCrossCheck(
  c: GatableCrossCheck,
  rowStatus: string,
): boolean {
  return (
    (c.applicable || c.attribute === "timeRestriction") &&
    c.attribute !== "address" &&
    rowStatus !== "applied"
  );
}

/** Is this cross-check actionable (checkbox shown / included in decisions)? */
export function isCrossCheckApplyable(
  c: GatableCrossCheck,
  overrides: Record<string, string>,
): boolean {
  return (
    (c.applicable || hasLocalOverride(c, overrides)) &&
    !c.blockedReason &&
    (c.status === "new" || c.status === "conflict" || c.status === "na")
  );
}
