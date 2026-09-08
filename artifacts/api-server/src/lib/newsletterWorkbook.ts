import * as XLSX from "xlsx";

type Cell = string | number | boolean | Date | null | undefined;
type Row = Cell[];

export interface ParsedNewsletterCampaign {
  id: string;
  subject: string;
  sentAt: Date;
  sentTimeText: string | null;
  previewUrl: string | null;
  openRate: number | null;
  clickRate: number | null;
  sourceSheet: string;
}

export interface ParsedNewsletterContact {
  normalizedEmail: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  sourceCurrentSubscriber: boolean;
  sourceUnsubscribed: boolean;
  sourceBounced: boolean;
  unsubscribeEvidence: string[];
  bounceEvidence: string[];
}

export interface ParsedNewsletterEngagement {
  campaignId: string;
  normalizedEmail: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  deliveredAt: Date | null;
  opened: boolean;
  lastOpenedAt: Date | null;
  totalOpens: number;
  clicked: boolean;
  lastClickedAt: Date | null;
  totalClicks: number;
  clickedLinks: string[];
}

export interface ParsedNewsletterWorkbook {
  campaigns: ParsedNewsletterCampaign[];
  contacts: ParsedNewsletterContact[];
  engagement: ParsedNewsletterEngagement[];
  currentActiveEmails: string[];
  currentUnsubscribedEmails: string[];
  bouncedEmailsToInvalidate: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function text(value: Cell): string | null {
  if (value === null || value === undefined) return null;
  const result = String(value).trim();
  return result ? result : null;
}

function email(value: Cell): string | null {
  const candidate = text(value)?.toLowerCase() ?? null;
  return candidate && EMAIL_RE.test(candidate) ? candidate : null;
}

function bool(value: Cell): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return ["true", "yes", "1", "x"].includes(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
}

function integer(value: Cell): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
}

function rate(value: Cell): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed =
    typeof value === "string"
      ? Number(value.replace("%", "")) / (value.includes("%") ? 100 : 1)
      : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateTime(value: Cell): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number") {
    const parts = XLSX.SSF.parse_date_code(value);
    if (!parts) return null;
    return new Date(
      Date.UTC(
        parts.y,
        parts.m - 1,
        parts.d,
        parts.H,
        parts.M,
        Math.floor(parts.S),
      ),
    );
  }
  const parsed = Date.parse(String(value ?? ""));
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/** Store campaign dates at noon UTC; the source time text is preserved separately. */
function campaignDate(value: Cell): Date {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return new Date(
      Date.UTC(
        value.getUTCFullYear(),
        value.getUTCMonth(),
        value.getUTCDate(),
        12,
      ),
    );
  }
  if (typeof value === "number") {
    const parts = XLSX.SSF.parse_date_code(value);
    if (parts) return new Date(Date.UTC(parts.y, parts.m - 1, parts.d, 12));
  }
  const raw = String(value ?? "").trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso)
    return new Date(
      Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), 12),
    );
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return new Date(
      Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 12),
    );
  }
  throw new Error(
    `Could not parse newsletter campaign date: ${raw || "(blank)"}`,
  );
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function rows(sheet: XLSX.WorkSheet): Row[] {
  return XLSX.utils.sheet_to_json<Row>(sheet, {
    header: 1,
    raw: true,
    defval: null,
  });
}

function sheet(
  book: XLSX.WorkBook,
  requested: string,
): { name: string; rows: Row[] } {
  const exact = book.SheetNames.find((name) => name === requested);
  const truncated = book.SheetNames.find((name) => requested.startsWith(name));
  const name = exact ?? truncated;
  if (!name) throw new Error(`Required worksheet not found: ${requested}`);
  return { name, rows: rows(book.Sheets[name]) };
}

function latest(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

export function parseNewsletterWorkbook(
  buffer: Buffer,
): ParsedNewsletterWorkbook {
  const book = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const dashboard = sheet(book, "Newsletter analytics dashboard");
  const campaignRows = dashboard.rows.slice(1, 12);
  const campaigns = new Map<string, ParsedNewsletterCampaign>();

  for (const row of campaignRows) {
    if (!text(row[0]) || !text(row[3])) continue;
    const sentAt = campaignDate(row[0]);
    const id = `flodesk:${dateKey(sentAt)}`;
    campaigns.set(id, {
      id,
      subject: text(row[3])!,
      sentAt,
      sentTimeText: text(row[2]),
      previewUrl: null,
      openRate: rate(row[4]),
      clickRate: rate(row[5]),
      sourceSheet: dashboard.name,
    });
  }

  const currentSheet = sheet(book, "FINAL LIST AUG 2026 (Flodesk)");
  const current = new Map<
    string,
    { email: string; firstName: string | null }
  >();
  for (const row of currentSheet.rows.slice(1)) {
    const address = email(row[1]);
    if (address)
      current.set(address, { email: address, firstName: text(row[0]) });
  }

  const unsubscribeEvidence = new Map<string, string[]>();
  const currentUnsubscribed = new Set<string>();
  const addUnsubscribe = (
    address: string,
    evidence: string,
    isCurrent: boolean,
  ) => {
    const existing = unsubscribeEvidence.get(address) ?? [];
    if (evidence && !existing.includes(evidence)) existing.push(evidence);
    unsubscribeEvidence.set(address, existing);
    if (isCurrent) currentUnsubscribed.add(address);
  };

  const oldUnsubscribeSheet = sheet(book, "Unsubscribe");
  for (const row of oldUnsubscribeSheet.rows.slice(2)) {
    const address = email(row[0]);
    if (address)
      addUnsubscribe(address, text(row[1]) ?? oldUnsubscribeSheet.name, false);
  }

  let unsubscribeSection: "current" | "historical" | null = null;
  for (const row of dashboard.rows.slice(20)) {
    const label = text(row[0]) ?? "";
    if (/^unsubscribes from august 2026/i.test(label)) {
      unsubscribeSection = "current";
      continue;
    }
    if (/^unsubscribes from /i.test(label)) {
      unsubscribeSection = "historical";
      continue;
    }
    if (/^click through/i.test(label)) unsubscribeSection = null;
    if (!unsubscribeSection) continue;
    const address = row.map(email).find((value): value is string => !!value);
    if (address) {
      const evidence = row
        .map(text)
        .filter(
          (value): value is string =>
            !!value && !EMAIL_RE.test(value.toLowerCase()),
        )
        .join(" · ");
      addUnsubscribe(
        address,
        evidence || dashboard.name,
        unsubscribeSection === "current",
      );
    }
  }

  const bounceSheet = sheet(book, "Bounced");
  const bounceEvidence = new Map<string, string[]>();
  for (let index = 1; index < bounceSheet.rows.length; index += 1) {
    const address = email(bounceSheet.rows[index]?.[0]);
    if (!address) continue;
    const evidence = text(bounceSheet.rows[index + 1]?.[0]) ?? bounceSheet.name;
    const existing = bounceEvidence.get(address) ?? [];
    if (!existing.includes(evidence)) existing.push(evidence);
    bounceEvidence.set(address, existing);
  }

  const engagement = new Map<string, ParsedNewsletterEngagement>();
  const mergeEngagement = (next: ParsedNewsletterEngagement) => {
    const key = `${next.campaignId}|${next.normalizedEmail}`;
    const prior = engagement.get(key);
    if (!prior) {
      engagement.set(key, next);
      return;
    }
    engagement.set(key, {
      ...prior,
      firstName: prior.firstName ?? next.firstName,
      lastName: prior.lastName ?? next.lastName,
      deliveredAt: prior.deliveredAt ?? next.deliveredAt,
      opened: prior.opened || next.opened,
      lastOpenedAt: latest(prior.lastOpenedAt, next.lastOpenedAt),
      totalOpens: Math.max(prior.totalOpens, next.totalOpens),
      clicked: prior.clicked || next.clicked,
      lastClickedAt: latest(prior.lastClickedAt, next.lastClickedAt),
      totalClicks: Math.max(prior.totalClicks, next.totalClicks),
      clickedLinks: [...new Set([...prior.clickedLinks, ...next.clickedLinks])],
    });
  };

  const parseStandard = (requestedSheet: string, campaignId: string) => {
    const source = sheet(book, requestedSheet);
    const headerIndex = source.rows.findIndex(
      (row) => text(row[0])?.toLowerCase() === "email_address",
    );
    if (headerIndex < 0)
      throw new Error(`Recipient analytics header not found in ${source.name}`);
    const header = source.rows[headerIndex].map(
      (value) => text(value)?.toLowerCase() ?? "",
    );
    const column = (name: string) => header.indexOf(name);
    const previewColumn = column("email_preview_link");
    for (const row of source.rows.slice(headerIndex + 1)) {
      const address = email(row[column("email_address")]);
      if (!address) continue;
      const previewUrl = previewColumn >= 0 ? text(row[previewColumn]) : null;
      const campaign = campaigns.get(campaignId);
      if (campaign && previewUrl && !campaign.previewUrl)
        campaign.previewUrl = previewUrl;
      mergeEngagement({
        campaignId,
        normalizedEmail: address,
        email: address,
        firstName:
          column("first_name") >= 0 ? text(row[column("first_name")]) : null,
        lastName:
          column("last_name") >= 0 ? text(row[column("last_name")]) : null,
        deliveredAt:
          column("delivered") >= 0 ? dateTime(row[column("delivered")]) : null,
        opened: column("opened") >= 0 ? bool(row[column("opened")]) : true,
        lastOpenedAt:
          column("last_opened") >= 0
            ? dateTime(row[column("last_opened")])
            : null,
        totalOpens:
          column("total_times_opened") >= 0
            ? integer(row[column("total_times_opened")])
            : 0,
        clicked: column("clicked") >= 0 ? bool(row[column("clicked")]) : false,
        lastClickedAt: null,
        totalClicks: 0,
        clickedLinks: [],
      });
    }
    return source;
  };

  const feb2025 = parseStandard(
    "February Newsletter Analytics",
    "flodesk:2025-02-11",
  );
  for (const row of feb2025.rows.slice(4)) {
    const address = email(row[6]);
    if (!address) continue;
    mergeEngagement({
      campaignId: "flodesk:2025-02-11",
      normalizedEmail: address,
      email: address,
      firstName: null,
      lastName: null,
      deliveredAt: null,
      opened: true,
      lastOpenedAt: null,
      totalOpens: 0,
      clicked: true,
      lastClickedAt: null,
      totalClicks: 1,
      clickedLinks: [],
    });
  }

  parseStandard("May 2025 analytics ", "flodesk:2025-05-23");
  const seedlings = parseStandard(
    "2025 Seedlings Newsletter Analytics",
    "flodesk:2025-08-27",
  );
  for (const row of seedlings.rows.slice(1, 67)) {
    const address = email(row[0]);
    if (!address) continue;
    mergeEngagement({
      campaignId: "flodesk:2025-08-27",
      normalizedEmail: address,
      email: address,
      firstName: null,
      lastName: null,
      deliveredAt: null,
      opened: true,
      lastOpenedAt: null,
      totalOpens: 0,
      clicked: true,
      lastClickedAt: null,
      totalClicks: 1,
      clickedLinks: [],
    });
  }
  parseStandard("Analytics Feb 2026", "flodesk:2026-02-11");
  const august2026 = parseStandard(
    "August 2026 Analytics",
    "flodesk:2026-08-20",
  );
  for (const row of august2026.rows.slice(2, 50)) {
    const address = email(row[1]);
    if (!address) continue;
    mergeEngagement({
      campaignId: "flodesk:2026-08-20",
      normalizedEmail: address,
      email: address,
      firstName: null,
      lastName: null,
      deliveredAt: null,
      opened: true,
      lastOpenedAt: null,
      totalOpens: 0,
      clicked: true,
      lastClickedAt: dateTime(row[3]),
      totalClicks: integer(row[2]),
      clickedLinks: text(row[0]) ? [text(row[0])!] : [],
    });
  }

  const contacts = new Map<string, ParsedNewsletterContact>();
  const allAddresses = new Set<string>([
    ...current.keys(),
    ...unsubscribeEvidence.keys(),
    ...bounceEvidence.keys(),
    ...[...engagement.values()].map((row) => row.normalizedEmail),
  ]);
  for (const address of allAddresses) {
    const currentRow = current.get(address);
    const historyRow = [...engagement.values()].find(
      (row) => row.normalizedEmail === address,
    );
    contacts.set(address, {
      normalizedEmail: address,
      email: address,
      firstName: currentRow?.firstName ?? historyRow?.firstName ?? null,
      lastName: historyRow?.lastName ?? null,
      sourceCurrentSubscriber:
        current.has(address) && !currentUnsubscribed.has(address),
      sourceUnsubscribed: unsubscribeEvidence.has(address),
      sourceBounced: bounceEvidence.has(address),
      unsubscribeEvidence: unsubscribeEvidence.get(address) ?? [],
      bounceEvidence: bounceEvidence.get(address) ?? [],
    });
  }

  const currentActiveEmails = [...contacts.values()]
    .filter((row) => row.sourceCurrentSubscriber)
    .map((row) => row.normalizedEmail);
  const bouncedEmailsToInvalidate = [...bounceEvidence.keys()].filter(
    (address) => !current.has(address),
  );

  return {
    campaigns: [...campaigns.values()].sort(
      (a, b) => b.sentAt.getTime() - a.sentAt.getTime(),
    ),
    contacts: [...contacts.values()],
    engagement: [...engagement.values()],
    currentActiveEmails,
    currentUnsubscribedEmails: [...currentUnsubscribed],
    bouncedEmailsToInvalidate,
  };
}
