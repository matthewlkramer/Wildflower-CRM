import { Router, type IRouter } from "express";
import { and, count, desc, eq, exists, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  wildflowerUpdateItems,
  wildflowerUpdateRelatedLinks,
  wildflowerUpdateSources,
  regions,
  people,
  organizations,
} from "@workspace/db/schema";
import {
  CreateWildflowerUpdateItemBody,
  ListWildflowerUpdateItemsQueryParams,
  UpdateWildflowerUpdateItemBody,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { getAppUser } from "../lib/appRequest";
import { asyncHandler, newId, notFound, paramId, parseBoolQuery, parseOrBadRequest, parsePagination, normalizeArrayQuery } from "../lib/helpers";
import { expandRegionIdsForFilter } from "../lib/regionContainment";
import {
  normalizeWildflowerSourceUrl,
  nonEmptyWildflowerText,
  wildflowerDateRangeIsOrdered,
  wildflowerEventDateKey,
} from "../lib/wildflowerUpdateRules";
import {
  ListRelevantWildflowerUpdateItemsQueryParams,
} from "@workspace/api-zod";
import { getRelevantWildflowerUpdates } from "../lib/wildflowerUpdateRelevance";

const router: IRouter = Router();
router.use(requireAuth);

type EventDate = {
  precision: "exact" | "month" | "year" | "season" | "date_range" | "school_year" | "month_range" | "unknown";
  startDate?: string | null;
  endDate?: string | null;
  year?: number | null;
  startYear?: number | null;
  startMonth?: number | null;
  endYear?: number | null;
  endMonth?: number | null;
  month?: number | null;
  season?: string | null;
};
type SourceInput = {
  sourceType: "sent_newsletter" | "published_article" | "donor_proposal" | "draft";
  title: string;
  url: string;
  publicationDatePrecision: EventDate["precision"];
  publicationDate?: string | null;
  publicationEndDate?: string | null;
  publicationYear?: number | null;
  publicationMonth?: number | null;
  publicationStartYear?: number | null;
  publicationStartMonth?: number | null;
  publicationEndYear?: number | null;
  publicationEndMonth?: number | null;
  publicationSeason?: string | null;
};
type LinkInput = { title: string; url: string };

function normalizeText(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function validateEventDate(date: EventDate): string | null {
  const has = (v: unknown) => v !== undefined && v !== null && v !== "";
  const expected: Record<EventDate["precision"], string> = {
    exact: "startDate",
    month: "year and month",
    year: "year",
    season: "year and season",
    date_range: "startDate and endDate",
    school_year: "startYear and endYear",
    month_range: "startYear, startMonth, endYear, and endMonth",
    unknown: "no date components",
  };
  if (date.precision === "exact" && (!has(date.startDate) || has(date.endDate) || has(date.year) || has(date.startYear) || has(date.endYear) || has(date.month) || has(date.season))) return `Exact dates require ${expected.exact} only.`;
  if (date.precision === "month" && (!has(date.year) || !has(date.month) || has(date.startDate) || has(date.endDate) || has(date.startYear) || has(date.endYear) || has(date.season))) return `Month dates require ${expected.month}.`;
  if (date.precision === "year" && (!has(date.year) || has(date.startDate) || has(date.endDate) || has(date.startYear) || has(date.endYear) || has(date.month) || has(date.season))) return `Year dates require ${expected.year} only.`;
  if (date.precision === "season" && (!has(date.year) || !has(date.season) || has(date.startDate) || has(date.endDate) || has(date.startYear) || has(date.endYear) || has(date.month))) return `Season dates require ${expected.season}.`;
  if (date.precision === "date_range" && (!has(date.startDate) || !has(date.endDate) || has(date.year) || has(date.startYear) || has(date.endYear) || has(date.month) || has(date.season))) return `Date ranges require ${expected.date_range}.`;
  if (date.precision === "school_year" && (!has(date.startYear) || !has(date.endYear) || has(date.startDate) || has(date.endDate) || has(date.year) || has(date.startMonth) || has(date.endMonth) || has(date.month) || has(date.season))) return `School-year dates require ${expected.school_year}.`;
  if (date.precision === "month_range" && (!has(date.startYear) || !has(date.startMonth) || !has(date.endYear) || !has(date.endMonth) || has(date.startDate) || has(date.endDate) || has(date.year) || has(date.month) || has(date.season))) return `Month ranges require ${expected.month_range}.`;
  if (date.precision === "unknown" && (has(date.startDate) || has(date.endDate) || has(date.year) || has(date.startYear) || has(date.startMonth) || has(date.endYear) || has(date.endMonth) || has(date.month) || has(date.season))) return `Unknown dates require ${expected.unknown}.`;
  if (date.precision === "date_range" && String(date.startDate) > String(date.endDate)) return "Date range startDate must not be after endDate.";
  if (date.precision === "school_year" && Number(date.startYear) > Number(date.endYear)) return "School-year startYear must not be after endYear.";
  if (date.precision === "month_range" && (Number(date.startYear) > Number(date.endYear) || (Number(date.startYear) === Number(date.endYear) && Number(date.startMonth) > Number(date.endMonth)))) return "Month range start must not be after end.";
  return null;
}

function validateSource(source: SourceInput): string | null {
  const has = (v: unknown) => v !== undefined && v !== null && v !== "";
  if (!nonEmptyWildflowerText(source.title) || !nonEmptyWildflowerText(source.url)) {
    return "Source title and URL must not be blank.";
  }
  const hasMonthRangePart = has(source.publicationStartYear) || has(source.publicationStartMonth) || has(source.publicationEndYear) || has(source.publicationEndMonth);
  if (source.publicationDatePrecision === "exact" && (!has(source.publicationDate) || has(source.publicationEndDate) || has(source.publicationYear) || has(source.publicationMonth) || hasMonthRangePart || has(source.publicationSeason))) return "Exact source publication dates require publicationDate only.";
  if (source.publicationDatePrecision === "month" && (!has(source.publicationYear) || !has(source.publicationMonth) || has(source.publicationDate) || has(source.publicationEndDate) || hasMonthRangePart || has(source.publicationSeason))) return "Month source publication dates require publicationYear and publicationMonth.";
  if (source.publicationDatePrecision === "year" && (!has(source.publicationYear) || has(source.publicationDate) || has(source.publicationEndDate) || hasMonthRangePart || has(source.publicationMonth) || has(source.publicationSeason))) return "Year source publication dates require publicationYear only.";
  if (source.publicationDatePrecision === "season" && (!has(source.publicationYear) || !has(source.publicationSeason) || has(source.publicationDate) || has(source.publicationEndDate) || hasMonthRangePart || has(source.publicationMonth))) return "Season source publication dates require publicationYear and publicationSeason.";
  if (source.publicationDatePrecision === "date_range" && (!has(source.publicationDate) || !has(source.publicationEndDate) || has(source.publicationYear) || hasMonthRangePart || has(source.publicationMonth) || has(source.publicationSeason))) return "Source date ranges require publicationDate and publicationEndDate.";
  if (source.publicationDatePrecision === "month_range" && (!has(source.publicationStartYear) || !has(source.publicationStartMonth) || !has(source.publicationEndYear) || !has(source.publicationEndMonth) || has(source.publicationDate) || has(source.publicationEndDate) || has(source.publicationYear) || has(source.publicationMonth) || has(source.publicationSeason))) return "Source month ranges require publicationStartYear, publicationStartMonth, publicationEndYear, and publicationEndMonth.";
  if (source.publicationDatePrecision === "date_range" && !wildflowerDateRangeIsOrdered(source.publicationDate, source.publicationEndDate)) return "Source publication date range start must not be after end.";
  if (source.publicationDatePrecision === "month_range" && (Number(source.publicationStartYear) > Number(source.publicationEndYear) || (Number(source.publicationStartYear) === Number(source.publicationEndYear) && Number(source.publicationStartMonth) > Number(source.publicationEndMonth)))) return "Source month range start must not be after end.";
  if (source.publicationDatePrecision === "unknown" && (has(source.publicationDate) || has(source.publicationEndDate) || has(source.publicationYear) || hasMonthRangePart || has(source.publicationMonth) || has(source.publicationSeason))) return "Unknown source publication dates cannot include date components.";
  return null;
}

function validateRelatedLink(link: LinkInput): string | null {
  if (!nonEmptyWildflowerText(link.title) || !nonEmptyWildflowerText(link.url)) {
    return "Related link title and URL must not be blank.";
  }
  return null;
}

function eventIntervalStartSql() {
  return sql`CASE
    WHEN ${wildflowerUpdateItems.datePrecision} IN ('exact', 'date_range')
      THEN ${wildflowerUpdateItems.eventStartDate}
    WHEN ${wildflowerUpdateItems.datePrecision} = 'month'
      THEN make_date(${wildflowerUpdateItems.eventYear}, ${wildflowerUpdateItems.eventMonth}, 1)
    WHEN ${wildflowerUpdateItems.datePrecision} = 'year'
      THEN make_date(${wildflowerUpdateItems.eventYear}, 1, 1)
    WHEN ${wildflowerUpdateItems.datePrecision} = 'school_year'
      THEN make_date(${wildflowerUpdateItems.eventStartYear}, 1, 1)
    WHEN ${wildflowerUpdateItems.datePrecision} = 'month_range'
      THEN make_date(${wildflowerUpdateItems.eventStartYear}, ${wildflowerUpdateItems.eventStartMonth}, 1)
    WHEN ${wildflowerUpdateItems.datePrecision} = 'season'
      AND lower(${wildflowerUpdateItems.eventSeason}) IN ('spring', 'summer', 'autumn', 'fall', 'winter')
      THEN CASE lower(${wildflowerUpdateItems.eventSeason})
        WHEN 'spring' THEN make_date(${wildflowerUpdateItems.eventYear}, 3, 1)
        WHEN 'summer' THEN make_date(${wildflowerUpdateItems.eventYear}, 6, 1)
        WHEN 'autumn' THEN make_date(${wildflowerUpdateItems.eventYear}, 9, 1)
        WHEN 'fall' THEN make_date(${wildflowerUpdateItems.eventYear}, 9, 1)
        WHEN 'winter' THEN make_date(${wildflowerUpdateItems.eventYear}, 12, 1)
      END
    ELSE NULL
  END`;
}

function eventIntervalEndSql() {
  return sql`CASE
    WHEN ${wildflowerUpdateItems.datePrecision} = 'exact'
      THEN ${wildflowerUpdateItems.eventStartDate}
    WHEN ${wildflowerUpdateItems.datePrecision} = 'date_range'
      THEN ${wildflowerUpdateItems.eventEndDate}
    WHEN ${wildflowerUpdateItems.datePrecision} = 'month'
      THEN (make_date(${wildflowerUpdateItems.eventYear}, ${wildflowerUpdateItems.eventMonth}, 1) + interval '1 month - 1 day')::date
    WHEN ${wildflowerUpdateItems.datePrecision} = 'year'
      THEN (make_date(${wildflowerUpdateItems.eventYear}, 1, 1) + interval '1 year - 1 day')::date
    WHEN ${wildflowerUpdateItems.datePrecision} = 'school_year'
      THEN (make_date(${wildflowerUpdateItems.eventEndYear}, 1, 1) + interval '1 year - 1 day')::date
    WHEN ${wildflowerUpdateItems.datePrecision} = 'month_range'
      THEN (make_date(${wildflowerUpdateItems.eventEndYear}, ${wildflowerUpdateItems.eventEndMonth}, 1) + interval '1 month - 1 day')::date
    WHEN ${wildflowerUpdateItems.datePrecision} = 'season'
      AND lower(${wildflowerUpdateItems.eventSeason}) IN ('spring', 'summer', 'autumn', 'fall', 'winter')
      THEN CASE lower(${wildflowerUpdateItems.eventSeason})
        WHEN 'spring' THEN make_date(${wildflowerUpdateItems.eventYear}, 5, 31)
        WHEN 'summer' THEN make_date(${wildflowerUpdateItems.eventYear}, 8, 31)
        WHEN 'autumn' THEN make_date(${wildflowerUpdateItems.eventYear}, 11, 30)
        WHEN 'fall' THEN make_date(${wildflowerUpdateItems.eventYear}, 11, 30)
        WHEN 'winter' THEN (make_date(${wildflowerUpdateItems.eventYear} + 1, 3, 1) - interval '1 day')::date
      END
    ELSE NULL
  END`;
}

function eventDateResponse(row: typeof wildflowerUpdateItems.$inferSelect): EventDate {
  return {
    precision: row.datePrecision,
    startDate: row.eventStartDate,
    endDate: row.eventEndDate,
    year: row.eventYear,
    startYear: row.eventStartYear,
    startMonth: row.eventStartMonth,
    endYear: row.eventEndYear,
    endMonth: row.eventEndMonth,
    month: row.eventMonth,
    season: row.eventSeason,
  };
}

async function formatItem(row: typeof wildflowerUpdateItems.$inferSelect) {
  const [sources, links] = await Promise.all([
    db.select().from(wildflowerUpdateSources).where(eq(wildflowerUpdateSources.itemId, row.id)).orderBy(wildflowerUpdateSources.createdAt),
    db.select().from(wildflowerUpdateRelatedLinks).where(eq(wildflowerUpdateRelatedLinks.itemId, row.id)).orderBy(wildflowerUpdateRelatedLinks.createdAt),
  ]);
  return {
    id: row.id,
    title: row.title,
    details: row.details,
    qualification: row.qualification,
    importKey: row.importKey,
    eventDate: eventDateResponse(row),
    status: row.status,
    preparationStatus: row.preparationStatus,
    thematicTags: row.thematicTags ?? [],
    ageTags: row.ageTags ?? [],
    governanceTags: row.governanceTags ?? [],
    fundingRegionIds: row.fundingRegionIds ?? [],
    sources: sources.map((source) => ({
      id: source.id,
      sourceType: source.sourceType,
      title: source.title,
      url: source.url,
      publicationDatePrecision: source.publicationDatePrecision,
      publicationDate: source.publicationDate,
      publicationEndDate: source.publicationEndDate,
      publicationYear: source.publicationYear,
      publicationMonth: source.publicationMonth,
      publicationStartYear: source.publicationStartYear,
      publicationStartMonth: source.publicationStartMonth,
      publicationEndYear: source.publicationEndYear,
      publicationEndMonth: source.publicationEndMonth,
      publicationSeason: source.publicationSeason,
    })),
    relatedLinks: links.map((link) => ({ id: link.id, title: link.title, url: link.url })),
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function eventColumns(date: EventDate) {
  return {
    datePrecision: date.precision,
    eventStartDate: date.precision === "exact" || date.precision === "date_range" ? date.startDate ?? null : null,
    eventEndDate: date.precision === "date_range" ? date.endDate ?? null : null,
    eventYear: date.precision === "month" || date.precision === "year" || date.precision === "season" ? date.year ?? null : null,
    eventStartYear: date.precision === "school_year" || date.precision === "month_range" ? date.startYear ?? null : null,
    eventStartMonth: date.precision === "month_range" ? date.startMonth ?? null : null,
    eventEndYear: date.precision === "school_year" || date.precision === "month_range" ? date.endYear ?? null : null,
    eventEndMonth: date.precision === "month_range" ? date.endMonth ?? null : null,
    eventMonth: date.precision === "month" ? date.month ?? null : null,
    eventSeason: date.precision === "season" ? date.season ?? null : null,
    eventDateKey: wildflowerEventDateKey(date),
  };
}

async function insertCollections(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], itemId: string, sources: SourceInput[], links: LinkInput[]) {
  if (sources.length) {
    await tx.insert(wildflowerUpdateSources).values(sources.map((source) => ({
      id: newId(),
      itemId,
      sourceType: source.sourceType,
      title: source.title.trim(),
      url: source.url.trim(),
      normalizedUrl: normalizeWildflowerSourceUrl(source.url),
      publicationDatePrecision: source.publicationDatePrecision,
      publicationDate: source.publicationDate ?? null,
      publicationEndDate: source.publicationEndDate ?? null,
      publicationYear: source.publicationYear ?? null,
      publicationMonth: source.publicationMonth ?? null,
      publicationStartYear: source.publicationStartYear ?? null,
      publicationStartMonth: source.publicationStartMonth ?? null,
      publicationEndYear: source.publicationEndYear ?? null,
      publicationEndMonth: source.publicationEndMonth ?? null,
      publicationSeason: source.publicationSeason ?? null,
    })));
  }
  if (links.length) {
    await tx.insert(wildflowerUpdateRelatedLinks).values(links.map((link) => ({
      id: newId(),
      itemId,
      title: link.title.trim(),
      url: link.url.trim(),
      normalizedUrl: normalizeWildflowerSourceUrl(link.url),
    })));
  }
}

async function validateRegionIds(ids: string[]): Promise<string | null> {
  const unique = [...new Set(ids)];
  if (!unique.length) return null;
  const rows = await db.select({ id: regions.id }).from(regions).where(inArray(regions.id, unique));
  if (rows.length !== unique.length) return "fundingRegionIds must contain canonical region IDs.";
  return null;
}

function duplicateResponse(res: import("express").Response) {
  res.status(409).json({ error: "duplicate", message: "A Wildflower update item or source URL already exists." });
}

router.get("/wildflower-update-items", asyncHandler(async (req, res) => {
  const query = normalizeArrayQuery(req.query as Record<string, unknown>, ["status", "interest", "geography", "sourceType"]);
  const q = parseOrBadRequest(ListWildflowerUpdateItemsQueryParams, query, res);
  if (!q) return;
  const { limit, page, offset } = parsePagination(q);
  const filters: SQL[] = [];
  if (parseBoolQuery(req, "includeArchived") !== true) filters.push(isNull(wildflowerUpdateItems.archivedAt));
  if (q.search) filters.push(or(ilike(wildflowerUpdateItems.title, `%${q.search}%`), ilike(wildflowerUpdateItems.details, `%${q.search}%`))!);
  if (q.dateFrom || q.dateTo) {
    const eventStart = eventIntervalStartSql();
    const eventEnd = eventIntervalEndSql();
    // A bounded filter is an interval-overlap query. Unknown (and malformed
    // season) precision resolves to NULL and therefore cannot match.
    if (q.dateFrom) filters.push(sql`${eventEnd} >= ${q.dateFrom}::date`);
    if (q.dateTo) filters.push(sql`${eventStart} <= ${q.dateTo}::date`);
    filters.push(sql`${eventStart} IS NOT NULL AND ${eventEnd} IS NOT NULL`);
  }
  if (q.status?.length) filters.push(inArray(wildflowerUpdateItems.status, q.status));
  if (q.interest?.length) {
    filters.push(or(
      sql`${wildflowerUpdateItems.thematicTags} && ARRAY[${sql.join(q.interest.map((v) => sql`${v}`), sql`, `)}]::text[]`,
      sql`${wildflowerUpdateItems.ageTags} && ARRAY[${sql.join(q.interest.map((v) => sql`${v}`), sql`, `)}]::text[]`,
      sql`${wildflowerUpdateItems.governanceTags} && ARRAY[${sql.join(q.interest.map((v) => sql`${v}`), sql`, `)}]::text[]`,
    )!);
  }
  if (q.geography?.length) {
    const geography = await expandRegionIdsForFilter(q.geography);
    filters.push(sql`${wildflowerUpdateItems.fundingRegionIds} && ARRAY[${sql.join(geography.map((v) => sql`${v}`), sql`, `)}]::text[]`);
  }
  if (q.sourceType?.length) {
    filters.push(exists(db.select({ id: wildflowerUpdateSources.id }).from(wildflowerUpdateSources).where(and(eq(wildflowerUpdateSources.itemId, wildflowerUpdateItems.id), inArray(wildflowerUpdateSources.sourceType, q.sourceType)))));
  }
  const where = filters.length ? and(...filters) : undefined;
  const [rows, [{ value: total } = { value: 0 }]] = await Promise.all([
    db.select().from(wildflowerUpdateItems).where(where)
      .orderBy(
        sql`${wildflowerUpdateItems.eventStartDate} DESC NULLS LAST`,
        sql`${wildflowerUpdateItems.eventStartYear} DESC NULLS LAST`,
        sql`${wildflowerUpdateItems.eventStartMonth} DESC NULLS LAST`,
        sql`${wildflowerUpdateItems.eventYear} DESC NULLS LAST`,
        sql`${wildflowerUpdateItems.eventMonth} DESC NULLS LAST`,
        desc(wildflowerUpdateItems.createdAt),
      )
      .limit(limit).offset(offset),
    db.select({ value: count() }).from(wildflowerUpdateItems).where(where),
  ]);
  res.json({ data: await Promise.all(rows.map(formatItem)), pagination: { page, limit, total: Number(total) } });
}));

router.get("/wildflower-update-items/relevant", asyncHandler(async (req, res) => {
  const q = parseOrBadRequest(
    ListRelevantWildflowerUpdateItemsQueryParams,
    req.query,
    res,
  );
  if (!q) return;
  const hasPerson = Boolean(q.personId);
  const hasOrganization = Boolean(q.organizationId);
  if (hasPerson === hasOrganization) {
    res.status(400).json({
      error: "validation_error",
      message: "Exactly one of personId or organizationId is required.",
    });
    return;
  }

  const entity = hasPerson
    ? await db
        .select({
          id: people.id,
          interestsThematic: people.interestsThematic,
          interestsAges: people.interestsAges,
          interestsGovModels: people.interestsGovModels,
          regionIds: people.regionIds,
        })
        .from(people)
        .where(eq(people.id, q.personId!))
        .limit(1)
        .then((rows) => rows[0])
    : await db
        .select({
          id: organizations.id,
          interestsThematic: organizations.interestsThematic,
          interestsAges: organizations.interestsAges,
          interestsGovModels: organizations.interestsGovModels,
          regionIds: organizations.regionIds,
        })
        .from(organizations)
        .where(eq(organizations.id, q.organizationId!))
        .limit(1)
        .then((rows) => rows[0]);
  if (!entity) {
    notFound(res, hasPerson ? "person" : "organization");
    return;
  }
  const updates = await getRelevantWildflowerUpdates({
    interests: [
      ...(entity.interestsThematic ?? []),
      ...(entity.interestsAges ?? []),
      ...(entity.interestsGovModels ?? []),
    ],
    fundingRegionIds: entity.regionIds ?? [],
    limit: q.limit,
  });
  res.json({ data: updates });
}));

router.post("/wildflower-update-items", asyncHandler(async (req, res) => {
  const body = parseOrBadRequest(CreateWildflowerUpdateItemBody, req.body, res);
  if (!body) return;
  if (!nonEmptyWildflowerText(body.title)) {
    res.status(400).json({ error: "validation_error", message: "Title must not be blank." });
    return;
  }
  const dateError = validateEventDate(body.eventDate as EventDate);
  if (dateError || !nonEmptyWildflowerText(body.details) || body.details.includes("\n") || body.details.includes("\r")) {
    res.status(400).json({ error: "validation_error", message: dateError ?? "Details must be one non-empty paragraph without line breaks." });
    return;
  }
  const sourceError = body.sources.map((s) => validateSource(s as SourceInput)).find(Boolean);
  if (body.sources.length === 0) {
    res.status(400).json({
      error: "validation_error",
      message: "At least one source is required.",
    });
    return;
  }
  if (sourceError) { res.status(400).json({ error: "validation_error", message: sourceError }); return; }
  const relatedLinkError = body.relatedLinks.map((link) => validateRelatedLink(link as LinkInput)).find(Boolean);
  if (relatedLinkError) { res.status(400).json({ error: "validation_error", message: relatedLinkError }); return; }
  const regionError = await validateRegionIds(body.fundingRegionIds);
  if (regionError) { res.status(400).json({ error: "validation_error", message: regionError }); return; }
  const normalizedHeadline = normalizeText(body.title);
  const event = body.eventDate as EventDate;
  const eventDateKey = wildflowerEventDateKey(event);
  const existing = await db.select({ id: wildflowerUpdateItems.id }).from(wildflowerUpdateItems).where(and(eq(wildflowerUpdateItems.normalizedHeadline, normalizedHeadline), eq(wildflowerUpdateItems.eventDateKey, eventDateKey))).limit(1);
  if (existing.length) { duplicateResponse(res); return; }
  const duplicateUrls = new Set<string>();
  for (const source of body.sources as SourceInput[]) {
    const normalized = normalizeWildflowerSourceUrl(source.url);
    if (duplicateUrls.has(normalized)) { duplicateResponse(res); return; }
    duplicateUrls.add(normalized);
  }
  try {
    const item = await db.transaction(async (tx) => {
      const [created] = await tx.insert(wildflowerUpdateItems).values({
        id: newId(), title: body.title.trim(), details: body.details.trim(),
        qualification: body.qualification?.trim() || null,
        ...eventColumns(event),
        status: body.status, preparationStatus: body.preparationStatus,
        thematicTags: body.thematicTags, ageTags: body.ageTags,
        governanceTags: body.governanceTags, fundingRegionIds: body.fundingRegionIds,
        normalizedHeadline,
      }).returning();
      await insertCollections(tx, created.id, body.sources as SourceInput[], body.relatedLinks as LinkInput[]);
      return created;
    });
    res.status(201).json(await formatItem(item));
  } catch (error) {
    if (String(error).includes("wildflower_update_")) { duplicateResponse(res); return; }
    throw error;
  }
}));

async function findItem(id: string) {
  const [row] = await db.select().from(wildflowerUpdateItems).where(eq(wildflowerUpdateItems.id, id)).limit(1);
  return row;
}

router.get("/wildflower-update-items/:id", asyncHandler(async (req, res) => {
  const row = await findItem(paramId(req));
  if (!row) { notFound(res, "Wildflower update item"); return; }
  res.json(await formatItem(row));
}));

router.patch("/wildflower-update-items/:id", asyncHandler(async (req, res) => {
  const body = parseOrBadRequest(UpdateWildflowerUpdateItemBody, req.body, res);
  if (!body) return;
  const id = paramId(req);
  const current = await findItem(id);
  if (!current) { notFound(res, "Wildflower update item"); return; }
  const mergedDate = (body.eventDate ?? eventDateResponse(current)) as EventDate;
  const title = body.title ?? current.title;
  const details = body.details ?? current.details;
  if (!nonEmptyWildflowerText(title)) {
    res.status(400).json({ error: "validation_error", message: "Title must not be blank." });
    return;
  }
  const dateError = validateEventDate(mergedDate);
  if (dateError || !nonEmptyWildflowerText(details) || details.includes("\n") || details.includes("\r")) {
    res.status(400).json({ error: "validation_error", message: dateError ?? "Details must be one non-empty paragraph without line breaks." });
    return;
  }
  const sources = body.sources as SourceInput[] | undefined;
  const [existingSources, existingRelatedLinks] = await Promise.all([
    db.select().from(wildflowerUpdateSources).where(eq(wildflowerUpdateSources.itemId, id)),
    db.select().from(wildflowerUpdateRelatedLinks).where(eq(wildflowerUpdateRelatedLinks.itemId, id)),
  ]);
  if (sources && sources.length === 0) {
    res.status(400).json({
      error: "validation_error",
      message: "At least one source is required; source replacement cannot be empty.",
    });
    return;
  }
  const mergedSources: SourceInput[] = sources ?? existingSources.map((source) => ({
    sourceType: source.sourceType,
    title: source.title,
    url: source.url,
    publicationDatePrecision: source.publicationDatePrecision,
    publicationDate: source.publicationDate,
    publicationEndDate: source.publicationEndDate,
    publicationYear: source.publicationYear,
    publicationMonth: source.publicationMonth,
    publicationStartYear: source.publicationStartYear,
    publicationStartMonth: source.publicationStartMonth,
    publicationEndYear: source.publicationEndYear,
    publicationEndMonth: source.publicationEndMonth,
    publicationSeason: source.publicationSeason,
  }));
  if (mergedSources.length === 0) {
    res.status(400).json({
      error: "validation_error",
      message: "At least one source is required.",
    });
    return;
  }
  const mergedSourceError = mergedSources.map(validateSource).find(Boolean);
  if (mergedSourceError) {
    res.status(400).json({ error: "validation_error", message: mergedSourceError });
    return;
  }
  const regionError = body.fundingRegionIds
    ? await validateRegionIds(body.fundingRegionIds)
    : null;
  if (regionError) { res.status(400).json({ error: "validation_error", message: regionError }); return; }
  if (sources) {
    const seen = new Set<string>();
    if (sources.some((source) => { const normalized = normalizeWildflowerSourceUrl(source.url); if (seen.has(normalized)) return true; seen.add(normalized); return false; })) { duplicateResponse(res); return; }
  }
  const relatedLinks = body.relatedLinks as LinkInput[] | undefined;
  const mergedRelatedLinks: LinkInput[] = relatedLinks ?? existingRelatedLinks.map((link) => ({
    title: link.title,
    url: link.url,
  }));
  {
    const relatedLinkError = mergedRelatedLinks.map(validateRelatedLink).find(Boolean);
    if (relatedLinkError) { res.status(400).json({ error: "validation_error", message: relatedLinkError }); return; }
  }
  const normalizedHeadline = normalizeText(title);
  const eventDateKey = wildflowerEventDateKey(mergedDate);
  const conflict = await db.select({ id: wildflowerUpdateItems.id }).from(wildflowerUpdateItems).where(and(eq(wildflowerUpdateItems.normalizedHeadline, normalizedHeadline), eq(wildflowerUpdateItems.eventDateKey, eventDateKey), sql`${wildflowerUpdateItems.id} <> ${id}`)).limit(1);
  if (conflict.length) { duplicateResponse(res); return; }
  try {
    const updated = await db.transaction(async (tx) => {
      if (sources) await tx.delete(wildflowerUpdateSources).where(eq(wildflowerUpdateSources.itemId, id));
      if (relatedLinks) await tx.delete(wildflowerUpdateRelatedLinks).where(eq(wildflowerUpdateRelatedLinks.itemId, id));
      const [saved] = await tx.update(wildflowerUpdateItems).set({
        title: title.trim(), details: details.trim(),
        qualification: body.qualification === undefined
          ? current.qualification
          : body.qualification?.trim() || null,
        ...eventColumns(mergedDate),
        status: body.status ?? current.status,
        preparationStatus: body.preparationStatus ?? current.preparationStatus,
        thematicTags: body.thematicTags ?? current.thematicTags,
        ageTags: body.ageTags ?? current.ageTags, governanceTags: body.governanceTags ?? current.governanceTags,
        fundingRegionIds: body.fundingRegionIds ?? current.fundingRegionIds, normalizedHeadline, updatedAt: new Date(),
      }).where(eq(wildflowerUpdateItems.id, id)).returning();
      if (sources || relatedLinks) await insertCollections(tx, id, sources ?? [], relatedLinks ?? []);
      return saved;
    });
    res.json(await formatItem(updated));
  } catch (error) {
    if (String(error).includes("wildflower_update_")) { duplicateResponse(res); return; }
    throw error;
  }
}));

async function setArchived(req: import("express").Request, res: import("express").Response, archived: boolean) {
  const id = paramId(req);
  const [row] = await db.update(wildflowerUpdateItems).set({
    archivedAt: archived ? new Date() : null,
    archivedByUserId: archived ? getAppUser(req)?.id ?? null : null,
    updatedAt: new Date(),
  }).where(eq(wildflowerUpdateItems.id, id)).returning();
  if (!row) { notFound(res, "Wildflower update item"); return; }
  res.json(await formatItem(row));
}

router.post("/wildflower-update-items/:id/archive", asyncHandler((req, res) => setArchived(req, res, true)));
router.post("/wildflower-update-items/:id/unarchive", asyncHandler((req, res) => setArchived(req, res, false)));

export default router;