/** Read-only receipt planning. No payment-to-installment match is persisted. */
export function remainingFundingSchedule(
  rows: Array<{ id: string; expectedDate: string; amount: string | null }>,
  paid: number,
  unpaid: number | null,
) {
  let paymentLeft = Math.max(0, Math.round(paid * 100));
  let capacityLeft =
    unpaid == null ? null : Math.max(0, Math.round(unpaid * 100));
  let ambiguousCoverage = false;
  return [...rows]
    .sort(
      (a, b) =>
        a.expectedDate.localeCompare(b.expectedDate) ||
        Number(b.amount == null) - Number(a.amount == null) ||
        a.id.localeCompare(b.id),
    )
    .map((row) => {
      const amount = row.amount == null ? null : Number(row.amount);
      if (amount == null || !Number.isFinite(amount) || amount < 0) {
        // An unknown earlier installment may have consumed recorded payments.
        // Do not pretend we know the remaining amount of later installments.
        if (paymentLeft > 0) ambiguousCoverage = true;
        return { ...row, remaining: null };
      }
      if (ambiguousCoverage || capacityLeft == null)
        return { ...row, remaining: null };
      const cents = Math.round(amount * 100);
      const covered = Math.min(paymentLeft, cents);
      paymentLeft -= covered;
      const remaining = Math.min(capacityLeft, cents - covered);
      capacityLeft -= remaining;
      return { ...row, remaining: remaining / 100 };
    });
}
