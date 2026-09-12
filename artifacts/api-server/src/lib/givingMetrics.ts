/**
 * Collapse received payments into their pledge for count/largest metrics.
 *
 * A pledge payment is evidence of money received, not another gift-sized
 * giving event. Relationship totals still use the payment rows (the amount
 * that actually arrived), while card metrics use this projection so a pledge
 * and its installments count once.
 */
export type GivingMetricInput = {
  id: string;
  amount: string | null;
  dateReceived: string | null;
  opportunityId: string | null;
  pledgeAmount: string | null;
  pledgeDate: string | null;
  pledgePaymentStatus: string | null;
};

export type GivingMetric = {
  id: string;
  amount: string;
  dateReceived: string | null;
  kind: "gift" | "pledge";
};

function cents(value: string | null): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

export function collapsePledgePayments(rows: GivingMetricInput[]): GivingMetric[] {
  const metrics = new Map<string, GivingMetric>();
  for (const row of rows) {
    if (row.opportunityId && row.pledgeAmount != null) {
      // The pledge header is the metric identity. Multiple installments
      // therefore replace one another rather than increasing the count.
      metrics.set(`pledge:${row.opportunityId}`, {
        id: row.opportunityId,
        amount: row.pledgeAmount,
        dateReceived: row.pledgeDate,
        kind: "pledge",
      });
      continue;
    }
    metrics.set(`gift:${row.id}`, {
      id: row.id,
      amount: row.amount ?? "0.00",
      dateReceived: row.dateReceived,
      kind: "gift",
    });
  }
  return [...metrics.values()];
}

export function largestGivingMetric(
  metrics: GivingMetric[],
): GivingMetric | null {
  return metrics.reduce<GivingMetric | null>((largest, metric) => {
    if (!largest || cents(metric.amount) > cents(largest.amount)) return metric;
    return largest;
  }, null);
}