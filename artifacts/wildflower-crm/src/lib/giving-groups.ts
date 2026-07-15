/**
 * Pure grouping logic for the "Giving & pipeline" card on donor detail
 * pages. Buckets opportunities/pledges by their derived status and nests
 * each gift under its source opportunity (gift.opportunityId) so a pledge
 * and its payments read as one thread.
 *
 * Never-hide guarantee: every opportunity appears in exactly one section
 * and every gift appears exactly once — nested under its opportunity if
 * that opportunity is in the fetched set, otherwise standalone under
 * "Past giving". Dormant/lost records are surfaced in a labeled muted
 * tail section rather than filtered out.
 */

export interface GivingOppLike {
  id: string;
  /** Derived opportunity status: open / pledge / cash_in / dormant / lost. */
  status?: string | null;
}

export interface GivingGiftLike {
  id: string;
  /** Source pledge/opportunity this gift pays into, when any. */
  opportunityId?: string | null;
  dateReceived?: string | null;
}

export interface GivingThread<O, G> {
  opp: O;
  /** Gifts that pay into this opportunity, in the order the server returned them. */
  gifts: G[];
}

export interface PastGivingEntry<O, G> {
  /** Null for a standalone gift with no (fetched) source opportunity. */
  opp: O | null;
  gifts: G[];
}

export interface GivingGroups<O extends GivingOppLike, G extends GivingGiftLike> {
  /** status === "open" — active asks still being negotiated. */
  openAsks: GivingThread<O, G>[];
  /** status === "pledge" — committed, waiting for (more) payment. */
  waitingForPayment: GivingThread<O, G>[];
  /** Completed (cash_in / anything unrecognized) threads + standalone gifts, newest first. */
  pastGiving: PastGivingEntry<O, G>[];
  /** status dormant/lost — shown muted but never hidden. */
  dormantOrLost: GivingThread<O, G>[];
}

function latestGiftDate(gifts: GivingGiftLike[]): string | null {
  let latest: string | null = null;
  for (const g of gifts) {
    if (g.dateReceived && (latest === null || g.dateReceived > latest)) {
      latest = g.dateReceived;
    }
  }
  return latest;
}

export function groupGiving<O extends GivingOppLike, G extends GivingGiftLike>(
  opps: O[],
  gifts: G[],
): GivingGroups<O, G> {
  const oppIds = new Set(opps.map((o) => o.id));
  const giftsByOpp = new Map<string, G[]>();
  const standaloneGifts: G[] = [];
  for (const g of gifts) {
    if (g.opportunityId && oppIds.has(g.opportunityId)) {
      const list = giftsByOpp.get(g.opportunityId);
      if (list) list.push(g);
      else giftsByOpp.set(g.opportunityId, [g]);
    } else {
      standaloneGifts.push(g);
    }
  }

  const openAsks: GivingThread<O, G>[] = [];
  const waitingForPayment: GivingThread<O, G>[] = [];
  const dormantOrLost: GivingThread<O, G>[] = [];
  const pastOppEntries: PastGivingEntry<O, G>[] = [];

  for (const opp of opps) {
    const thread: GivingThread<O, G> = {
      opp,
      gifts: giftsByOpp.get(opp.id) ?? [],
    };
    switch (opp.status) {
      case "open":
        openAsks.push(thread);
        break;
      case "pledge":
        waitingForPayment.push(thread);
        break;
      case "dormant":
      case "lost":
        dormantOrLost.push(thread);
        break;
      default:
        // cash_in plus anything unrecognized — never drop a record on the
        // floor just because its status is unexpected.
        pastOppEntries.push({ opp, gifts: thread.gifts });
        break;
    }
  }

  const pastGiving: PastGivingEntry<O, G>[] = [
    ...pastOppEntries,
    ...standaloneGifts.map((g) => ({ opp: null, gifts: [g] })),
  ]
    .map((entry, index) => ({ entry, index, date: latestGiftDate(entry.gifts) }))
    .sort((a, b) => {
      // Newest first; entries without any dated gift sink to the end.
      // Ties keep their original relative order (stable by index).
      if (a.date === b.date) return a.index - b.index;
      if (a.date === null) return 1;
      if (b.date === null) return -1;
      return a.date < b.date ? 1 : -1;
    })
    .map(({ entry }) => entry);

  return { openAsks, waitingForPayment, pastGiving, dormantOrLost };
}
