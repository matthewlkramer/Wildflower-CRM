export type PlannedAmountRow = { id: string; amount: string | null };

/**
 * Scale editable plan rows by a parent amount reduction using integer cents.
 * Largest-remainder allocation keeps every line non-negative and makes the
 * new plan total exactly match the rounded proportional total. Null amounts
 * stay null.
 */
export function scalePlannedAmounts(
  rows: PlannedAmountRow[],
  oldTarget: number,
  newTarget: number,
): PlannedAmountRow[] {
  const oldTargetCents = Math.round(oldTarget * 100);
  const newTargetCents = Math.round(newTarget * 100);
  if (
    oldTargetCents <= 0 ||
    newTargetCents < 0 ||
    newTargetCents >= oldTargetCents
  ) {
    throw new Error("scalePlannedAmounts requires a non-negative reduction");
  }

  const valued = rows.flatMap((row, index) => {
    if (row.amount == null) return [];
    const cents = Math.round(Number(row.amount) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      throw new Error(`Invalid planned amount for ${row.id}`);
    }
    return [{ ...row, cents, index }];
  });
  const totalCents = valued.reduce((sum, row) => sum + row.cents, 0);
  const targetPlanCents = Math.round(
    (totalCents * newTargetCents) / oldTargetCents,
  );

  const allocations = valued.map((row) => {
    const numerator = row.cents * newTargetCents;
    return {
      ...row,
      scaledCents: Math.floor(numerator / oldTargetCents),
      remainder: numerator % oldTargetCents,
    };
  });
  const floorTotal = allocations.reduce((sum, row) => sum + row.scaledCents, 0);
  const centsToDistribute = targetPlanCents - floorTotal;
  const recipients = [...allocations]
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index)
    .slice(0, centsToDistribute);
  const recipientIds = new Set(recipients.map((row) => row.id));
  const scaled = new Map(
    allocations.map((row) => [
      row.id,
      ((row.scaledCents + (recipientIds.has(row.id) ? 1 : 0)) / 100).toFixed(2),
    ]),
  );

  return rows.map((row) => ({
    id: row.id,
    amount: row.amount == null ? null : (scaled.get(row.id) ?? row.amount),
  }));
}
