import { readFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { db } from "@workspace/db";
import {
  wildflowerUpdateItems,
  wildflowerUpdateRelatedLinks,
  wildflowerUpdateSources,
} from "@workspace/db/schema";
import {
  normalizeWildflowerSourceUrl,
  wildflowerEventDateKey,
} from "./wildflowerUpdateRules";

export type WildflowerNewsBatchDate = {
  precision:
    | "exact"
    | "month"
    | "year"
    | "season"
    | "date_range"
    | "school_year"
    | "month_range"
    | "unknown";
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

export type WildflowerNewsBatchEntry = {
  importKey: string;
  title: string;
  details: string;
  qualification?: string | null;
  eventDate: WildflowerNewsBatchDate;
  status:
    | "completed"
    | "reported_progress"
    | "work_in_progress"
    | "proposed_work"
    | "announcement";
  preparationStatus?: "eligible" | "hold_for_confirmation";
  thematicTags?: string[];
  ageTags?: string[];
  governanceTags?: string[];
  fundingRegionIds?: string[];
  sourceKeys: string[];
  relatedLinks?: Array<{ title: string; url: string }>;
};

type RegisterSource = {
  key: string;
  title: string;
  sourceType: "sent_newsletter" | "published_article" | "donor_proposal" | "draft";
  url: string;
  sourceDate: {
    precision: WildflowerNewsBatchDate["precision"];
    date?: string;
    year?: number;
    month?: number;
    endYear?: number;
    endMonth?: number;
    season?: string;
  };
};

type SourceRegister = { sources: RegisterSource[] };

export const DEFAULT_WILDFLOWER_SOURCE_REGISTER = path.resolve(
  process.cwd(),
  "docs/imports/wildflower-update-source-register.json",
);

export async function readWildflowerSourceRegister(
  registerPath = DEFAULT_WILDFLOWER_SOURCE_REGISTER,
): Promise<Map<string, RegisterSource>> {
  const parsed = JSON.parse(await readFile(registerPath, "utf8")) as SourceRegister;
  const sources = new Map<string, RegisterSource>();
  for (const source of parsed.sources ?? []) {
    if (sources.has(source.key)) {
      throw new Error(`Duplicate Wildflower source-register key: ${source.key}`);
    }
    sources.set(source.key, source);
  }
  return sources;
}

function sourceDateFields(sourceDate: RegisterSource["sourceDate"]) {
  if (
    sourceDate.precision === "month_range" &&
    (
      !sourceDate.year ||
      !sourceDate.month ||
      !sourceDate.endYear ||
      !sourceDate.endMonth ||
      sourceDate.year > sourceDate.endYear ||
      (sourceDate.year === sourceDate.endYear && sourceDate.month > sourceDate.endMonth)
    )
  ) {
    throw new Error("Wildflower month_range source dates must have an ordered start and end month.");
  }
  return {
    publicationDatePrecision: sourceDate.precision,
    publicationDate: sourceDate.precision === "exact" ? sourceDate.date ?? null : null,
    publicationEndDate: null,
    publicationYear:
      sourceDate.precision === "month" ||
      sourceDate.precision === "year" ||
      sourceDate.precision === "season"
        ? sourceDate.year ?? null
        : null,
    publicationMonth: sourceDate.precision === "month" ? sourceDate.month ?? null : null,
    publicationStartYear:
      sourceDate.precision === "month_range" ? sourceDate.year ?? null : null,
    publicationStartMonth:
      sourceDate.precision === "month_range" ? sourceDate.month ?? null : null,
    publicationEndYear:
      sourceDate.precision === "month_range" ? sourceDate.endYear ?? null : null,
    publicationEndMonth:
      sourceDate.precision === "month_range" ? sourceDate.endMonth ?? null : null,
    publicationSeason: sourceDate.precision === "season" ? sourceDate.season ?? null : null,
  };
}

function eventDateFields(eventDate: WildflowerNewsBatchDate) {
  if (
    eventDate.precision === "month_range" &&
    (
      !eventDate.startYear ||
      !eventDate.startMonth ||
      !eventDate.endYear ||
      !eventDate.endMonth ||
      eventDate.startYear > eventDate.endYear ||
      (eventDate.startYear === eventDate.endYear &&
        eventDate.startMonth > eventDate.endMonth)
    )
  ) {
    throw new Error("Wildflower month_range event dates must have an ordered start and end month.");
  }
  return {
    datePrecision: eventDate.precision,
    eventStartDate:
      eventDate.precision === "exact" || eventDate.precision === "date_range"
        ? eventDate.startDate ?? null
        : null,
    eventEndDate: eventDate.precision === "date_range" ? eventDate.endDate ?? null : null,
    eventYear:
      eventDate.precision === "month" ||
      eventDate.precision === "year" ||
      eventDate.precision === "season"
        ? eventDate.year ?? null
        : null,
    eventStartYear:
      eventDate.precision === "school_year" || eventDate.precision === "month_range"
        ? eventDate.startYear ?? null
        : null,
    eventStartMonth:
      eventDate.precision === "month_range" ? eventDate.startMonth ?? null : null,
    eventEndYear:
      eventDate.precision === "school_year" || eventDate.precision === "month_range"
        ? eventDate.endYear ?? null
        : null,
    eventEndMonth:
      eventDate.precision === "month_range" ? eventDate.endMonth ?? null : null,
    eventMonth: eventDate.precision === "month" ? eventDate.month ?? null : null,
    eventSeason: eventDate.precision === "season" ? eventDate.season ?? null : null,
    eventDateKey: wildflowerEventDateKey(eventDate),
  };
}

/**
 * Insert a reviewed batch without overwriting staff edits. Every entry must
 * reference at least one source-register key. A rerun conflicts on importKey
 * and skips the item and its child rows entirely.
 */
export async function importWildflowerNewsBatch(
  entries: WildflowerNewsBatchEntry[],
  options: { registerPath?: string } = {},
): Promise<{ inserted: number; skipped: number }> {
  const register = await readWildflowerSourceRegister(options.registerPath);
  let inserted = 0;
  let skipped = 0;

  for (const entry of entries) {
    if (!entry.importKey.trim()) throw new Error("Wildflower batch importKey must not be blank.");
    if (!entry.sourceKeys.length) {
      throw new Error(`Wildflower batch entry ${entry.importKey} has no source keys.`);
    }
    const sources = entry.sourceKeys.map((key) => {
      const source = register.get(key);
      if (!source) throw new Error(`Unknown Wildflower source-register key ${key}.`);
      return source;
    });
    const [item] = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(wildflowerUpdateItems)
        .values({
          id: nanoid(),
          importKey: entry.importKey.trim(),
          title: entry.title.trim(),
          details: entry.details.trim(),
          qualification: entry.qualification?.trim() || null,
          ...eventDateFields(entry.eventDate),
          status: entry.status,
          preparationStatus: entry.preparationStatus ?? "eligible",
          thematicTags: entry.thematicTags ?? [],
          ageTags: entry.ageTags ?? [],
          governanceTags: entry.governanceTags ?? [],
          fundingRegionIds: entry.fundingRegionIds ?? [],
          normalizedHeadline: entry.title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
        })
        .onConflictDoNothing({ target: wildflowerUpdateItems.importKey })
        .returning();
      if (!created) return [null] as const;
      await tx.insert(wildflowerUpdateSources).values(
        sources.map((source) => ({
          id: nanoid(),
          itemId: created.id,
          sourceType: source.sourceType,
          title: source.title,
          url: source.url,
          normalizedUrl: normalizeWildflowerSourceUrl(source.url),
          ...sourceDateFields(source.sourceDate),
        })),
      );
      if (entry.relatedLinks?.length) {
        await tx.insert(wildflowerUpdateRelatedLinks).values(
          entry.relatedLinks.map((link) => ({
            id: nanoid(),
            itemId: created.id,
            title: link.title,
            url: link.url,
            normalizedUrl: normalizeWildflowerSourceUrl(link.url),
          })),
        );
      }
      return [created] as const;
    });
    if (item) inserted++;
    else skipped++;
  }
  return { inserted, skipped };
}