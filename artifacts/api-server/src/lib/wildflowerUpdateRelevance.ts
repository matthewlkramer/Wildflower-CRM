import { db } from "@workspace/db";
import {
  wildflowerUpdateItems,
  wildflowerUpdateSources,
} from "@workspace/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { deriveContainment } from "./regionContainment";

export type RelevantWildflowerUpdate = {
  id: string;
  title: string;
  details: string;
  qualification: string | null;
  importKey: string | null;
  status: "completed" | "reported_progress" | "work_in_progress" | "proposed_work" | "announcement";
  eventDate: {
    precision: string;
    startDate: string | null;
    endDate: string | null;
    year: number | null;
    startYear: number | null;
    startMonth: number | null;
    endYear: number | null;
    endMonth: number | null;
    month: number | null;
    season: string | null;
  };
  topicMatches: string[];
  geographyMatches: string[];
  sources: Array<{
    id: string;
    title: string;
    url: string;
    sourceType: string;
    publicationDatePrecision: string;
    publicationDate: string | null;
    publicationEndDate: string | null;
    publicationYear: number | null;
    publicationMonth: number | null;
    publicationSeason: string | null;
  }>;
};

function topicKey(value: string): string {
  return value.trim().normalize("NFKD").toLowerCase();
}

/**
 * Returns only non-archived events with at least one source. Topic matching
 * uses the person's/organization's actual interest values, while geography
 * matching is symmetric: a donor geography containing an event geography and
 * an event geography containing a donor geography both count.
 */
export async function getRelevantWildflowerUpdates(args: {
  interests: string[];
  fundingRegionIds: string[];
  limit?: number;
}): Promise<RelevantWildflowerUpdate[]> {
  const rows = await db
    .select({ item: wildflowerUpdateItems, source: wildflowerUpdateSources })
    .from(wildflowerUpdateItems)
    .innerJoin(
      wildflowerUpdateSources,
      eq(wildflowerUpdateSources.itemId, wildflowerUpdateItems.id),
    )
    .where(
      and(
        isNull(wildflowerUpdateItems.archivedAt),
        eq(wildflowerUpdateItems.preparationStatus, "eligible"),
      ),
    );

  const byItem = new Map<string, { item: typeof rows[number]["item"]; sources: typeof rows[number]["source"][] }>();
  for (const row of rows) {
    const current = byItem.get(row.item.id);
    if (current) current.sources.push(row.source);
    else byItem.set(row.item.id, { item: row.item, sources: [row.source] });
  }

  const allRegionIds = [
    ...args.fundingRegionIds,
    ...[...byItem.values()].flatMap(({ item }) => item.fundingRegionIds ?? []),
  ];
  const containment = await deriveContainment(allRegionIds);
  const scope = (root: string) => new Set([root, ...(containment.get(root) ?? [])]);
  const interests = new Map(args.interests.map((value) => [topicKey(value), value]));
  const output: RelevantWildflowerUpdate[] = [];

  for (const { item, sources } of byItem.values()) {
    const itemTopics = [
      ...(item.thematicTags ?? []),
      ...(item.ageTags ?? []),
      ...(item.governanceTags ?? []),
    ];
    const topicMatches = itemTopics
      .filter((value) => interests.has(topicKey(value)))
      .map((value) => interests.get(topicKey(value)) ?? value)
      .filter((value, index, values) => values.indexOf(value) === index);
    const geographyMatches: string[] = [];
    for (const donorRegion of args.fundingRegionIds) {
      const donorScope = scope(donorRegion);
      for (const eventRegion of item.fundingRegionIds ?? []) {
        const eventScope = scope(eventRegion);
        if (donorScope.has(eventRegion) || eventScope.has(donorRegion)) {
          geographyMatches.push(eventRegion);
        }
      }
    }
    if (!topicMatches.length && !geographyMatches.length) continue;
    output.push({
      id: item.id,
      title: item.title,
      details: item.details,
      qualification: item.qualification,
      importKey: item.importKey,
      status: item.status,
      eventDate: {
        precision: item.datePrecision,
        startDate: item.eventStartDate,
        endDate: item.eventEndDate,
        year: item.eventYear,
        startYear: item.eventStartYear,
        startMonth: item.eventStartMonth,
        endYear: item.eventEndYear,
        endMonth: item.eventEndMonth,
        month: item.eventMonth,
        season: item.eventSeason,
      },
      topicMatches,
      geographyMatches: [...new Set(geographyMatches)],
      sources: sources.map((source) => ({
        id: source.id,
        title: source.title,
        url: source.url,
        sourceType: source.sourceType,
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
    });
  }
  output.sort((a, b) => {
    const ad = a.eventDate.startDate
      ?? `${a.eventDate.startYear ?? a.eventDate.year ?? 0}-${String(a.eventDate.startMonth ?? a.eventDate.month ?? 0).padStart(2, "0")}`;
    const bd = b.eventDate.startDate
      ?? `${b.eventDate.startYear ?? b.eventDate.year ?? 0}-${String(b.eventDate.startMonth ?? b.eventDate.month ?? 0).padStart(2, "0")}`;
    return bd.localeCompare(ad);
  });
  return output.slice(0, args.limit ?? 20);
}
