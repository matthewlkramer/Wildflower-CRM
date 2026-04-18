import { db } from "@workspace/db";
import {
  gifts,
  giftAllocations,
  individuals,
  households,
  fundingEntities,
  organizations,
} from "@workspace/db/schema";
import { eq, inArray, desc, and, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

const payerEntity = alias(fundingEntities, "payer_entity");
const payerOrg = alias(organizations, "payer_org");
const sponsorEntity = alias(fundingEntities, "sponsor_entity");
const sponsorOrg = alias(organizations, "sponsor_org");

export const giftJoinSelect = {
  gift: gifts,
  individualFirstName: individuals.firstName,
  individualLastName: individuals.lastName,
  householdName: households.name,
  entityName: fundingEntities.legalName,
  payerEntityName: payerEntity.legalName,
  payerOrgName: payerOrg.name,
  sponsorEntityName: sponsorEntity.legalName,
  sponsorOrgName: sponsorOrg.name,
} as const;

export type GiftJoinRow = {
  gift: typeof gifts.$inferSelect;
  individualFirstName: string | null;
  individualLastName: string | null;
  householdName: string | null;
  entityName: string | null;
  payerEntityName: string | null;
  payerOrgName: string | null;
  sponsorEntityName: string | null;
  sponsorOrgName: string | null;
};

export type ResolvedGift = typeof gifts.$inferSelect & {
  donorName: string | null;
  payerName: string | null;
  fiscalSponsorName: string | null;
  allocations: Array<typeof giftAllocations.$inferSelect>;
};

function resolveDonorName(r: GiftJoinRow): string | null {
  if (r.individualFirstName) {
    return `${r.individualFirstName} ${r.individualLastName ?? ""}`.trim();
  }
  return r.householdName ?? r.entityName ?? null;
}

export function resolveGiftNames(r: GiftJoinRow) {
  return {
    donorName: resolveDonorName(r),
    payerName: r.payerEntityName ?? r.payerOrgName ?? null,
    fiscalSponsorName: r.sponsorEntityName ?? r.sponsorOrgName ?? null,
  };
}

export function selectGiftsWithJoins(where?: SQL | undefined) {
  return db
    .select(giftJoinSelect)
    .from(gifts)
    .leftJoin(individuals, eq(gifts.individualId, individuals.id))
    .leftJoin(households, eq(gifts.householdId, households.id))
    .leftJoin(fundingEntities, eq(gifts.fundingEntityId, fundingEntities.id))
    .leftJoin(payerEntity, eq(gifts.payerFundingEntityId, payerEntity.id))
    .leftJoin(payerOrg, eq(gifts.payerOrganizationId, payerOrg.id))
    .leftJoin(
      sponsorEntity,
      eq(gifts.fiscalSponsorFundingEntityId, sponsorEntity.id),
    )
    .leftJoin(
      sponsorOrg,
      eq(gifts.fiscalSponsorOrganizationId, sponsorOrg.id),
    )
    .where(where);
}

export async function fetchGiftsWith(
  where: SQL | undefined,
  opts: { limit?: number; offset?: number } = {},
): Promise<ResolvedGift[]> {
  let query = selectGiftsWithJoins(where).orderBy(desc(gifts.cashReceivedDate));
  if (opts.limit != null) query = query.limit(opts.limit) as typeof query;
  if (opts.offset != null) query = query.offset(opts.offset) as typeof query;
  const rows = (await query) as GiftJoinRow[];

  const ids = rows.map((r) => r.gift.id);
  const allocs = ids.length
    ? await db
        .select()
        .from(giftAllocations)
        .where(inArray(giftAllocations.giftId, ids))
    : [];
  const allocsByGift = allocs.reduce<Record<string, typeof allocs>>(
    (acc, a) => {
      (acc[a.giftId] ??= []).push(a);
      return acc;
    },
    {},
  );

  return rows.map((r) => ({
    ...r.gift,
    ...resolveGiftNames(r),
    allocations: allocsByGift[r.gift.id] ?? [],
  }));
}
