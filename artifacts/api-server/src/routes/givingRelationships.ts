import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { GetGivingRelationshipParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { asyncHandler, notFound, parseOrBadRequest } from "../lib/helpers";
import { getViewer, maskName } from "../lib/identityVisibility";
import {
  loadDonorNode,
  resolveDonorRouting,
  type DonorKind,
  type DonorNode,
  type DonorRef,
  type SqlExecutor,
} from "../lib/donorRouting";

const router: IRouter = Router();
router.use(requireAuth);

type AttributionKind =
  | "direct"
  | "household"
  | "household_member"
  | "principal_organization";

type GiftRow = {
  id: string;
  name: string | null;
  amount: string | null;
  date_received: string | null;
  payment_method: string | null;
  donor_kind: DonorKind;
  donor_id: string;
  donor_name: string | null;
  donor_anonymous: boolean | null;
  donor_owner_user_id: string | null;
  payment_intermediary_id: string | null;
  payment_intermediary_name: string | null;
  attribution_kinds: AttributionKind[];
};

type BreakdownDefinition = {
  kind: AttributionKind;
  label: string;
  description: string;
};

function displayNode(node: DonorNode, req: Parameters<typeof getViewer>[0]) {
  const viewer = getViewer(req);
  const name =
    node.kind === "household"
      ? node.name
      : (maskName(
          node.name,
          { anonymous: node.anonymous, ownerUserId: node.ownerUserId },
          viewer,
        ) ?? "Anonymous");
  return { kind: node.kind, id: node.id, name };
}

function toCents(value: string | null) {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
}

function fromCents(value: number) {
  return (value / 100).toFixed(2);
}

function definitions(kind: DonorKind): BreakdownDefinition[] {
  if (kind === "individual") {
    return [
      {
        kind: "direct",
        label: "Recorded to this individual",
        description: "Gifts whose donor of record is this person.",
      },
      {
        kind: "household",
        label: "Primary household",
        description: "Gifts recorded to this person's primary household.",
      },
      {
        kind: "principal_organization",
        label: "Principal organizations",
        description:
          "Gifts from organizations where this person is a current principal.",
      },
    ];
  }
  if (kind === "household") {
    return [
      {
        kind: "direct",
        label: "Recorded to this household",
        description: "Gifts whose donor of record is this household.",
      },
      {
        kind: "household_member",
        label: "Household members",
        description: "Gifts recorded directly to current household members.",
      },
      {
        kind: "principal_organization",
        label: "Members' principal organizations",
        description:
          "Gifts from organizations where a current household member is a principal.",
      },
    ];
  }
  return [
    {
      kind: "direct",
      label: "Recorded to this organization",
      description: "Gifts whose donor of record is this organization.",
    },
  ];
}

const giftProjection = sql.raw(`
  SELECT
    g.id,
    g.name,
    g.amount::text AS amount,
    g.date_received::text AS date_received,
    g.payment_method::text AS payment_method,
    CASE
      WHEN g.organization_id IS NOT NULL THEN 'organization'
      WHEN g.individual_giver_person_id IS NOT NULL THEN 'individual'
      ELSE 'household'
    END::text AS donor_kind,
    COALESCE(g.organization_id, g.individual_giver_person_id, g.household_id) AS donor_id,
    CASE
      WHEN g.organization_id IS NOT NULL THEN donor_org.name
      WHEN g.individual_giver_person_id IS NOT NULL THEN COALESCE(
        NULLIF(BTRIM(donor_person.full_name), ''),
        NULLIF(BTRIM(CONCAT_WS(' ', donor_person.first_name, donor_person.last_name)), ''),
        donor_person.id
      )
      ELSE donor_household.name
    END AS donor_name,
    CASE
      WHEN g.organization_id IS NOT NULL THEN donor_org.anonymous
      WHEN g.individual_giver_person_id IS NOT NULL THEN donor_person.anonymous
      ELSE false
    END AS donor_anonymous,
    CASE
      WHEN g.organization_id IS NOT NULL THEN donor_org.owner_user_id
      WHEN g.individual_giver_person_id IS NOT NULL THEN donor_person.owner_user_id
      ELSE NULL
    END AS donor_owner_user_id,
    g.payment_intermediary_id,
    pi.name AS payment_intermediary_name,
    c.attribution_kinds
  FROM grouped c
  JOIN gifts_and_payments g ON g.id = c.gift_id
  LEFT JOIN organizations donor_org ON donor_org.id = g.organization_id
  LEFT JOIN people donor_person ON donor_person.id = g.individual_giver_person_id
  LEFT JOIN households donor_household ON donor_household.id = g.household_id
  LEFT JOIN payment_intermediaries pi ON pi.id = g.payment_intermediary_id
  ORDER BY g.date_received DESC NULLS LAST, g.created_at DESC, g.id
`);

async function giftRows(source: DonorRef): Promise<GiftRow[]> {
  if (source.kind === "individual") {
    const result = await db.execute(sql`
      WITH source AS (
        SELECT id, primary_household_id
        FROM people
        WHERE id = ${source.id} AND archived_at IS NULL
      ), candidates AS (
        SELECT g.id AS gift_id, 'direct'::text AS attribution_kind
        FROM gifts_and_payments g
        JOIN source s ON g.individual_giver_person_id = s.id
        WHERE g.archived_at IS NULL
        UNION ALL
        SELECT g.id, 'household'::text
        FROM gifts_and_payments g
        JOIN source s ON g.household_id = s.primary_household_id
        WHERE g.archived_at IS NULL AND s.primary_household_id IS NOT NULL
        UNION ALL
        SELECT g.id, 'principal_organization'::text
        FROM gifts_and_payments g
        JOIN people_entity_roles per ON per.organization_id = g.organization_id
        JOIN source s ON s.id = per.person_id
        WHERE g.archived_at IS NULL
          AND per.connection = 'principal'
          AND per.current = 'current'
      ), grouped AS (
        SELECT gift_id, array_agg(DISTINCT attribution_kind ORDER BY attribution_kind) AS attribution_kinds
        FROM candidates
        GROUP BY gift_id
      )
      ${giftProjection}
    `);
    return result.rows as GiftRow[];
  }

  if (source.kind === "household") {
    const result = await db.execute(sql`
      WITH candidates AS (
        SELECT g.id AS gift_id, 'direct'::text AS attribution_kind
        FROM gifts_and_payments g
        WHERE g.household_id = ${source.id} AND g.archived_at IS NULL
        UNION ALL
        SELECT g.id, 'household_member'::text
        FROM gifts_and_payments g
        JOIN people p ON p.id = g.individual_giver_person_id
        WHERE p.primary_household_id = ${source.id}
          AND p.archived_at IS NULL
          AND g.archived_at IS NULL
        UNION ALL
        SELECT g.id, 'principal_organization'::text
        FROM gifts_and_payments g
        WHERE g.archived_at IS NULL
          AND g.organization_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM people p
            JOIN people_entity_roles per ON per.person_id = p.id
            WHERE p.primary_household_id = ${source.id}
              AND p.archived_at IS NULL
              AND per.organization_id = g.organization_id
              AND per.connection = 'principal'
              AND per.current = 'current'
          )
      ), grouped AS (
        SELECT gift_id, array_agg(DISTINCT attribution_kind ORDER BY attribution_kind) AS attribution_kinds
        FROM candidates
        GROUP BY gift_id
      )
      ${giftProjection}
    `);
    return result.rows as GiftRow[];
  }

  const result = await db.execute(sql`
    WITH candidates AS (
      SELECT g.id AS gift_id, 'direct'::text AS attribution_kind
      FROM gifts_and_payments g
      WHERE g.organization_id = ${source.id} AND g.archived_at IS NULL
    ), grouped AS (
      SELECT gift_id, array_agg(DISTINCT attribution_kind ORDER BY attribution_kind) AS attribution_kinds
      FROM candidates
      GROUP BY gift_id
    )
    ${giftProjection}
  `);
  return result.rows as GiftRow[];
}

router.get(
  "/giving-relationships/:sourceKind/:sourceId",
  asyncHandler(async (req, res) => {
    const params = parseOrBadRequest(
      GetGivingRelationshipParams,
      req.params,
      res,
    );
    if (!params) return;
    const source: DonorRef = {
      kind: params.sourceKind,
      id: params.sourceId,
    };
    const sourceNode = await loadDonorNode(
      db as unknown as SqlExecutor,
      source,
    );
    if (!sourceNode) return notFound(res, "donor");

    const [rows, resolution] = await Promise.all([
      giftRows(source),
      resolveDonorRouting(source),
    ]);
    const viewer = getViewer(req);
    const defs = definitions(source.kind);
    const relationshipCents = rows.reduce(
      (sum, row) => sum + toCents(row.amount),
      0,
    );
    const directCents = rows
      .filter((row) => row.attribution_kinds.includes("direct"))
      .reduce((sum, row) => sum + toCents(row.amount), 0);
    const throughIntermediaryCents = rows
      .filter((row) => row.payment_intermediary_id !== null)
      .reduce((sum, row) => sum + toCents(row.amount), 0);
    const largest = rows.reduce<GiftRow | null>((current, row) => {
      if (!current || toCents(row.amount) > toCents(current.amount)) return row;
      return current;
    }, null);

    const breakdown = defs.map((definition) => {
      const matching = rows.filter((row) =>
        row.attribution_kinds.includes(definition.kind),
      );
      return {
        kind: definition.kind,
        label: definition.label,
        description: definition.description,
        amount: fromCents(
          matching.reduce((sum, row) => sum + toCents(row.amount), 0),
        ),
        giftCount: matching.length,
      };
    });

    const recentGifts = rows.slice(0, 10).map((row) => {
      const donorName =
        row.donor_kind === "household"
          ? row.donor_name
          : maskName(
              row.donor_name,
              {
                anonymous: row.donor_anonymous,
                ownerUserId: row.donor_owner_user_id,
              },
              viewer,
            );
      const attribution =
        defs.find((definition) =>
          row.attribution_kinds.includes(definition.kind),
        ) ?? defs[0];
      return {
        id: row.id,
        name: row.name,
        amount: row.amount ?? "0.00",
        dateReceived: row.date_received,
        paymentMethod: row.payment_method,
        donor: {
          kind: row.donor_kind,
          id: row.donor_id,
          name: donorName ?? "Anonymous",
        },
        paymentIntermediary:
          row.payment_intermediary_id && row.payment_intermediary_name
            ? {
                id: row.payment_intermediary_id,
                name: row.payment_intermediary_name,
              }
            : null,
        attributionKind: attribution.kind,
        attributionLabel: attribution.label,
      };
    });

    res.json({
      source: displayNode(sourceNode, req),
      resolvedDonor: resolution.resolved
        ? displayNode(resolution.resolved, req)
        : null,
      requiresDecision: resolution.requiresDecision,
      relationshipTotal: fromCents(relationshipCents),
      donorOfRecordTotal: fromCents(directCents),
      throughIntermediaryTotal: fromCents(throughIntermediaryCents),
      giftCount: rows.length,
      mostRecentGiftDate: rows[0]?.date_received ?? null,
      largestGift: largest
        ? {
            id: largest.id,
            amount: largest.amount ?? "0.00",
            dateReceived: largest.date_received,
          }
        : null,
      breakdown,
      recentGifts,
    });
  }),
);

export default router;
