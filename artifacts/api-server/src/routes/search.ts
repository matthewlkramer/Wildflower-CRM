import { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  organizations,
  people,
  households,
  opportunitiesAndPledges,
  giftsAndPayments,
} from "@workspace/db/schema";
import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { asyncHandler } from "../lib/helpers";
import { requireAuth } from "../middlewares/requireAuth";
import { activeOnlyUnlessAdmin } from "../lib/archive";
import { getViewer, maskName, canSeeIdentity, ANON_LABEL } from "../lib/identityVisibility";
import { donorDisplayColumns, maskDonorDisplayFields } from "../lib/donorJoinSelect";

const router: IRouter = Router();
router.use(requireAuth);

// Unified cross-entity search over the five core donor-facing entities.
//
// Each entity is matched HYBRID — a substring `ILIKE '%q%'` (so the box keeps
// its old prefix/substring behavior) OR a pg_trgm fuzzy `%` match (so typos
// still surface) — and ranked by a small relevance score: exact (3) > prefix
// (2) > substring (1) > fuzzy-only (0), with trigram `similarity()` as the
// tiebreak. The trigram operators come from the `pg_trgm` extension (already
// used by the QuickBooks matcher); the GIN indexes only accelerate them, so the
// query stays correct via sequential scan if the indexes are absent.
//
// Archived rows are excluded for non-admins (LIST semantics), and anonymous
// names are masked server-side so a global search never leaks an anonymous
// donor's real name to a viewer who isn't the owner or an admin.
//
// Opportunities/gifts match on their OWN name only (the donor is findable as a
// person/organization/household hit in the same response); their donor name is
// shown as a masked sublabel for context. When that donor is anonymous-and-
// hidden, the opp/gift TITLE is masked too — opp/gift names routinely embed the
// donor's name (e.g. "FY27 Arthur Rock gift"), so leaving the title unmasked
// would defeat the masked sublabel (mirrors the /top-priorities endpoint).

const MIN_LEN = 2;
const DEFAULT_PER_TYPE = 5;
const MAX_PER_TYPE = 20;

router.get(
  "/search",
  asyncHandler(async (req, res) => {
    const q = (typeof req.query["q"] === "string" ? req.query["q"] : "").trim();
    if (q.length < MIN_LEN) {
      res.json({
        people: [],
        organizations: [],
        households: [],
        opportunities: [],
        gifts: [],
      });
      return;
    }

    const rawLimit = Number(req.query["limitPerType"]);
    const perType = Number.isFinite(rawLimit)
      ? Math.min(MAX_PER_TYPE, Math.max(1, Math.trunc(rawLimit)))
      : DEFAULT_PER_TYPE;

    const viewer = getViewer(req);
    const like = `%${q}%`;
    const prefix = `${q}%`;

    // exact > prefix > substring > fuzzy-only, with trigram similarity tiebreak.
    const scoreOf = (col: SQL): SQL<number> => sql<number>`(CASE
      WHEN lower(${col}) = lower(${q}) THEN 3
      WHEN ${col} ILIKE ${prefix} THEN 2
      WHEN ${col} ILIKE ${like} THEN 1
      ELSE 0 END)::float + COALESCE(similarity(${col}, ${q}), 0)`;

    const personName = sql<string>`COALESCE(
      NULLIF(TRIM(${people.fullName}), ''),
      NULLIF(TRIM(CONCAT_WS(' ', ${people.firstName}, ${people.lastName})), '')
    )`;
    const personScore = scoreOf(personName);
    const orgName = sql<string>`${organizations.name}`;
    const orgScore = scoreOf(orgName);
    const hhName = sql<string>`${households.name}`;
    const hhScore = scoreOf(hhName);
    const oppName = sql<string>`${opportunitiesAndPledges.name}`;
    const oppScore = scoreOf(oppName);
    const giftName = sql<string>`${giftsAndPayments.name}`;
    const giftScore = scoreOf(giftName);

    const [peopleRows, orgRows, hhRows, oppRows, giftRows] = await Promise.all([
      db
        .select({
          id: people.id,
          label: personName,
          anonymous: people.anonymous,
          ownerUserId: people.ownerUserId,
          score: personScore,
        })
        .from(people)
        .where(
          and(
            sql`(${people.fullName} ILIKE ${like} OR ${people.firstName} ILIKE ${like} OR ${people.lastName} ILIKE ${like} OR ${personName} % ${q})`,
            activeOnlyUnlessAdmin(req, people.archivedAt),
          ),
        )
        .orderBy(desc(personScore), asc(personName))
        .limit(perType),
      db
        .select({
          id: organizations.id,
          label: organizations.name,
          anonymous: organizations.anonymous,
          ownerUserId: organizations.ownerUserId,
          score: orgScore,
        })
        .from(organizations)
        .where(
          and(
            sql`(${organizations.name} ILIKE ${like} OR ${organizations.name} % ${q})`,
            activeOnlyUnlessAdmin(req, organizations.archivedAt),
          ),
        )
        .orderBy(desc(orgScore), asc(organizations.name))
        .limit(perType),
      db
        .select({ id: households.id, label: households.name, score: hhScore })
        .from(households)
        .where(
          and(
            sql`(${households.name} ILIKE ${like} OR ${households.name} % ${q})`,
            activeOnlyUnlessAdmin(req, households.archivedAt),
          ),
        )
        .orderBy(desc(hhScore), asc(households.name))
        .limit(perType),
      db
        .select({
          id: opportunitiesAndPledges.id,
          label: opportunitiesAndPledges.name,
          score: oppScore,
          ...donorDisplayColumns,
        })
        .from(opportunitiesAndPledges)
        .leftJoin(organizations, eq(organizations.id, opportunitiesAndPledges.organizationId))
        .leftJoin(households, eq(households.id, opportunitiesAndPledges.householdId))
        .leftJoin(people, eq(people.id, opportunitiesAndPledges.individualGiverPersonId))
        .where(
          and(
            sql`(${opportunitiesAndPledges.name} ILIKE ${like} OR ${opportunitiesAndPledges.name} % ${q})`,
            activeOnlyUnlessAdmin(req, opportunitiesAndPledges.archivedAt),
          ),
        )
        .orderBy(desc(oppScore), asc(opportunitiesAndPledges.name))
        .limit(perType),
      db
        .select({
          id: giftsAndPayments.id,
          label: giftsAndPayments.name,
          score: giftScore,
          ...donorDisplayColumns,
        })
        .from(giftsAndPayments)
        .leftJoin(organizations, eq(organizations.id, giftsAndPayments.organizationId))
        .leftJoin(households, eq(households.id, giftsAndPayments.householdId))
        .leftJoin(people, eq(people.id, giftsAndPayments.individualGiverPersonId))
        .where(
          and(
            sql`(${giftsAndPayments.name} ILIKE ${like} OR ${giftsAndPayments.name} % ${q})`,
            activeOnlyUnlessAdmin(req, giftsAndPayments.archivedAt),
          ),
        )
        .orderBy(desc(giftScore), asc(giftsAndPayments.name))
        .limit(perType),
    ]);

    type MoneyRow = (typeof oppRows)[number] | (typeof giftRows)[number];

    const donorSublabel = (row: MoneyRow) => {
      const masked = maskDonorDisplayFields(row, viewer);
      return (
        masked.organizationName ??
        masked.individualGiverPersonName ??
        masked.householdName ??
        null
      );
    };

    // True when the row's donor (org or individual giver — households are never
    // anonymizable) is anonymous and hidden from this viewer.
    const donorHidden = (row: MoneyRow): boolean =>
      (row.organizationName != null &&
        !canSeeIdentity(
          {
            anonymous: row.organizationAnonymous,
            ownerUserId: row.organizationOwnerUserId,
          },
          viewer,
        )) ||
      (row.individualGiverPersonName != null &&
        !canSeeIdentity(
          {
            anonymous: row.individualGiverAnonymous,
            ownerUserId: row.individualGiverOwnerUserId,
          },
          viewer,
        ));

    // The opp/gift's own title is masked when its donor is hidden (see header).
    const moneyLabel = (row: MoneyRow): string =>
      donorHidden(row) ? ANON_LABEL : (row.label ?? `Untitled (${row.id})`);

    res.json({
      people: peopleRows.map((r) => ({
        type: "person" as const,
        id: r.id,
        label:
          maskName(r.label, { anonymous: r.anonymous, ownerUserId: r.ownerUserId }, viewer) ??
          "(no name)",
        sublabel: null,
        score: Number(r.score),
      })),
      organizations: orgRows.map((r) => ({
        type: "organization" as const,
        id: r.id,
        label:
          maskName(r.label, { anonymous: r.anonymous, ownerUserId: r.ownerUserId }, viewer) ??
          "(no name)",
        sublabel: null,
        score: Number(r.score),
      })),
      households: hhRows.map((r) => ({
        type: "household" as const,
        id: r.id,
        label: r.label,
        sublabel: null,
        score: Number(r.score),
      })),
      opportunities: oppRows.map((r) => ({
        type: "opportunity" as const,
        id: r.id,
        label: moneyLabel(r),
        sublabel: donorSublabel(r),
        score: Number(r.score),
      })),
      gifts: giftRows.map((r) => ({
        type: "gift" as const,
        id: r.id,
        label: moneyLabel(r),
        sublabel: donorSublabel(r),
        score: Number(r.score),
      })),
    });
  }),
);

export default router;
