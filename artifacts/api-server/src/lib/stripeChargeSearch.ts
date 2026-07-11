// Shared free-text donor filter for Stripe staged charges — payer name, payer
// email, charge description, and the statement descriptor (mirrors stripe.ts's
// own staged-charge search fields). Any substring hit counts. ONE definition so
// the stray-gift proposal (gifts-missing-qb) and the un-anchored payment search
// (reconciliationGraph.searchQbStaged with includeStripe) can never drift.
import { or, sql, type SQL } from "drizzle-orm";
import { stripeStagedCharges } from "@workspace/db/schema";
import { escapeLike } from "../routes/quickbooks/shared";

export function stripeChargeSearchWhereExpr(pattern: SQL): SQL {
  return or(
    sql`${stripeStagedCharges.payerName} ILIKE ${pattern}`,
    sql`${stripeStagedCharges.payerEmail} ILIKE ${pattern}`,
    sql`${stripeStagedCharges.description} ILIKE ${pattern}`,
    sql`${stripeStagedCharges.statementDescriptor} ILIKE ${pattern}`,
  )!;
}

export function stripeChargeSearchWhere(term: string): SQL {
  const like = `%${escapeLike(term)}%`;
  return stripeChargeSearchWhereExpr(sql`${like}`);
}
