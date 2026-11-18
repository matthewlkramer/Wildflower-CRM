import { db } from "@workspace/db";
import {
  developmentAgenda,
  developmentAgendaTasks,
  mediaMentions,
  meetingNotes,
  tasks,
} from "@workspace/db/schema";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { chicagoToday } from "./effectiveProjectedCloseDate";
import { developmentWeek, loadFunderTargets } from "./funderCadence";
import { newId } from "./helpers";
import type { Tx } from "./reconciliationCommit";
import { alias } from "drizzle-orm/pg-core";

type AgendaTemplateItem = { key: string; title: string; prompt?: string; legacyKey?: string };
const STANDING_CHECK_INS: readonly AgendaTemplateItem[] = [
  { key: "check_in", title: "Team check-in" },
  {
    key: "checklists", title: "Standing checklists", legacyKey: "open_actions",
    prompt: "Weekly: donor thank-yous, donor communication updates in CRM, and project updates. Twice monthly: tax acknowledgments. Monthly: upcoming grant and metrics deadlines. Quarterly: development circle update.",
  },
  { key: "metrics", title: "Development metrics", prompt: "Review the weekly Development Circle metrics." },
  { key: "projects", title: "Project updates", legacyKey: "fundraising_updates" },
];
const RECAP: AgendaTemplateItem = { key: "next_steps", title: "Agree on next steps" };
const standingByKey = new Map(STANDING_CHECK_INS.flatMap<[string, AgendaTemplateItem]>((item) =>
  item.legacyKey ? [[item.key, item], [item.legacyKey, item]] : [[item.key, item]],
));
export const isStandingCheckIn = (key: string | null) => key !== null && standingByKey.has(key);
const priorAgenda = alias(developmentAgenda, "prior_agenda");

export async function loadDevelopmentMeetings(
  filters: {
    id?: string;
    before?: string;
    organizationId?: string;
    personId?: string;
    householdId?: string;
  } = {},
) {
  const notes = await db
    .select()
    .from(meetingNotes)
    .where(
      and(
        isNotNull(meetingNotes.developmentWeek),
        filters.id ? eq(meetingNotes.id, filters.id) : undefined,
        filters.before
          ? lt(meetingNotes.developmentWeek, filters.before)
          : undefined,
        ...(["organizationId", "personId", "householdId"] as const).map(
          (key) =>
            filters[key]
              ? sql`EXISTS (SELECT 1 FROM development_agenda WHERE ${developmentAgenda.meetingId} = ${meetingNotes.id} AND ${developmentAgenda[key]} = ${filters[key]} AND ${developmentAgenda.removedAt} IS NULL)`
              : undefined,
        ),
      ),
    )
    .orderBy(desc(meetingNotes.developmentWeek))
    .limit(filters.id ? 1 : 16);
  if (!notes.length) return [];
  const rows = await db
    .select({
      item: developmentAgenda,
      sourceUrl: mediaMentions.url,
      carriedFromMeetingId: priorAgenda.meetingId,
    })
    .from(developmentAgenda)
    .leftJoin(priorAgenda, eq(priorAgenda.id, developmentAgenda.carriedFromId))
    .leftJoin(
      mediaMentions,
      and(
        eq(developmentAgenda.findingKind, "media"),
        eq(mediaMentions.id, developmentAgenda.findingId),
        eq(mediaMentions.dismissed, false),
      ),
    )
    .where(
      and(isNull(developmentAgenda.removedAt),
        inArray(developmentAgenda.meetingId, notes.map((note) => note.id))),
    )
    .orderBy(asc(developmentAgenda.position), asc(developmentAgenda.id));
  const items = rows.map(({ item: { templateKey, removedAt: _removedAt, ...item }, sourceUrl, carriedFromMeetingId }) => ({
    ...item,
    sourceUrl,
    carriedFromMeetingId,
    standingCheckIn: isStandingCheckIn(templateKey),
    standingPrompt: templateKey ? standingByKey.get(templateKey)?.prompt ?? null : null,
  }));
  const links = items.length
    ? await db
        .select({
          agendaItemId: developmentAgendaTasks.agendaItemId,
          task: tasks,
        })
        .from(developmentAgendaTasks)
        .innerJoin(tasks, eq(tasks.id, developmentAgendaTasks.taskId))
        .where(
          inArray(
            developmentAgendaTasks.agendaItemId,
            items.map((item) => item.id),
          ),
        )
        .orderBy(asc(tasks.createdAt))
    : [];
  const tasksByItem = new Map<string, (typeof tasks.$inferSelect)[]>();
  for (const { agendaItemId, task } of links) {
    const list = tasksByItem.get(agendaItemId) ?? [];
    list.push(task);
    tasksByItem.set(agendaItemId, list);
  }
  return notes.map(
    ({
      developmentWeek: weekStart,
      personId,
      organizationId,
      householdId,
      rawTranscript,
      artifacts,
      ...note
    }) => ({
      weekStart: weekStart!,
      // The agenda only needs the reviewable notes and action items. Raw source
      // material stays behind the existing meeting-note record.
      note: { ...note, rawTranscript: null },
      agenda: items
        .filter((item) => item.meetingId === note.id)
        .map((item) => ({
          ...item,
          tasks: tasksByItem.get(item.id) ?? [],
        })),
    }),
  );
}

export async function lockDevelopmentMeeting(tx: Tx, id: string) {
  const [note] = await tx
    .select()
    .from(meetingNotes)
    .where(
      and(eq(meetingNotes.id, id), isNotNull(meetingNotes.developmentWeek)),
    )
    .for("update");
  return note;
}

export async function refreshDevelopmentDonorLinks(tx: Tx, meetingId: string) {
  const rows = await tx
    .select({
      organizationId: developmentAgenda.organizationId,
      personId: developmentAgenda.personId,
      householdId: developmentAgenda.householdId,
    })
    .from(developmentAgenda)
    .where(and(eq(developmentAgenda.meetingId, meetingId), isNull(developmentAgenda.removedAt)));
  function distinct(key: keyof (typeof rows)[number]) {
    return [...new Set(rows.flatMap((row) => (row[key] ? [row[key]!] : [])))];
  }
  await tx
    .update(meetingNotes)
    .set({
      organizationIds: distinct("organizationId"),
      personIds: distinct("personId"),
      householdIds: distinct("householdId"),
    })
    .where(eq(meetingNotes.id, meetingId));
}

export async function createDevelopmentMeeting(
  date: string,
  userId: string,
  summaryOnly: boolean,
) {
  const weekStart = developmentWeek(date);
  return db.transaction(async (tx) => {
    const candidateId = newId();
    const [created] = await tx
      .insert(meetingNotes)
      .values({
        id: candidateId,
        title: "Weekly development meeting",
        meetingDate: new Date(date + "T18:00:00Z"),
        developmentWeek: weekStart,
        creatorUserId: userId,
        summaryOnly,
      })
      .onConflictDoNothing()
      .returning({ id: meetingNotes.id });
    let id = candidateId;
    if (!created) {
      const [existing] = await tx
        .select({ id: meetingNotes.id })
        .from(meetingNotes)
        .where(eq(meetingNotes.developmentWeek, weekStart))
        .for("update");
      id = existing!.id;
      if (weekStart < developmentWeek(chicagoToday())) return id;
    }

    const [prior] = await tx
      .select({ id: meetingNotes.id })
      .from(meetingNotes)
      .where(lt(meetingNotes.developmentWeek, weekStart))
      .orderBy(desc(meetingNotes.developmentWeek))
      .limit(1)
      .for("update");
    const hasOpenTasks = sql<boolean>`EXISTS (
      SELECT 1 FROM development_agenda_tasks a JOIN tasks t ON t.id = a.task_id
      WHERE a.agenda_item_id = development_agenda.id AND t.status IN ('open','waiting')
    )`;
    const unfinished = prior
      ? await tx
          .select({ ...getTableColumns(developmentAgenda), hasOpenTasks })
          .from(developmentAgenda)
          .where(
            and(
              eq(developmentAgenda.meetingId, prior.id),
              isNull(developmentAgenda.removedAt),
              or(sql`${developmentAgenda.status} <> 'done'`, hasOpenTasks),
            ),
          )
          .orderBy(asc(developmentAgenda.position))
      : [];
    const existing = created ? [] : await tx.select().from(developmentAgenda)
      .where(eq(developmentAgenda.meetingId, id))
      .orderBy(asc(developmentAgenda.position), asc(developmentAgenda.id));
    // Include removed items so reopening a pre-created agenda respects a
    // previous decision to take a carried item off that specific agenda.
    const roots = new Map<string, string>();
    if (existing.length && prior && unfinished.length) {
      const lineage = await tx.execute<{ item_id: string; root_id: string }>(sql`
        WITH RECURSIVE ancestry AS (
          SELECT id AS item_id, id, carried_from_id
          FROM development_agenda WHERE meeting_id IN (${id}, ${prior.id})
          UNION ALL
          SELECT child.item_id, parent.id, parent.carried_from_id
          FROM ancestry child JOIN development_agenda parent ON parent.id = child.carried_from_id
        )
        SELECT item_id, id AS root_id FROM ancestry WHERE carried_from_id IS NULL
      `);
      for (const row of lineage.rows) roots.set(row.item_id, row.root_id);
    }
    const presentRoots = new Set(existing.map((item) => roots.get(item.id) ?? item.id));
    const carried = unfinished.filter((item) =>
      !item.templateKey && !presentRoots.has(roots.get(item.id) ?? item.id) &&
      (!item.findingId || !existing.some((row) => row.findingKind === item.findingKind && row.findingId === item.findingId)),
    );

    const additions: Array<typeof developmentAgenda.$inferInsert> = [];
    async function includeTemplate({ key, title, legacyKey }: AgendaTemplateItem, position: number, align = false) {
      const slot = existing.find((item) => item.templateKey === key || item.templateKey === legacyKey);
      const previous = unfinished.find(
        (item) => (item.templateKey === key || item.templateKey === legacyKey) && item.hasOpenTasks,
      );
      if (!slot) {
        additions.push({ id: newId(), meetingId: id, templateKey: key, title, position, carriedFromId: previous?.id });
      } else if (!slot.removedAt) {
        const carryId = slot.carriedFromId ?? previous?.id;
        if ((align && position !== slot.position) || carryId !== (slot.carriedFromId ?? undefined)) {
          await tx.update(developmentAgenda).set({
            position: align ? position : undefined,
            carriedFromId: carryId,
            revision: slot.revision + 1,
          }).where(eq(developmentAgenda.id, slot.id));
        }
      }
    }
    const firstPosition = existing.length ? existing.at(-1)!.position + 1 : 0;
    const alignStanding = STANDING_CHECK_INS.some(({ key, legacyKey }) =>
      !existing.some((item) => item.templateKey === key || item.templateKey === legacyKey));
    for (const [index, item] of STANDING_CHECK_INS.entries()) {
      await includeTemplate(item, index, alignStanding);
    }
    additions.push(...carried.map((item, index) => ({
      id: newId(),
      meetingId: id,
      title: item.title,
      notes: item.notes,
      position: firstPosition + (existing.length ? 0 : STANDING_CHECK_INS.length) + index,
      organizationId: item.organizationId,
      personId: item.personId,
      householdId: item.householdId,
      findingKind: item.findingKind,
      findingId: item.findingId,
      carriedFromId: item.id,
    })));
    await includeTemplate(RECAP, firstPosition + STANDING_CHECK_INS.length + carried.length);
    if (additions.length) await tx.insert(developmentAgenda).values(additions);
    await tx.execute(sql`
      INSERT INTO development_agenda_tasks (agenda_item_id, request_id, task_id)
      SELECT new.id, old.request_id, old.task_id
      FROM development_agenda new
      JOIN development_agenda_tasks old ON old.agenda_item_id = new.carried_from_id
      JOIN tasks t ON t.id = old.task_id
      WHERE new.meeting_id = ${id} AND new.removed_at IS NULL AND t.status IN ('open','waiting')
      ON CONFLICT (agenda_item_id, request_id) DO NOTHING
    `);
    await refreshDevelopmentDonorLinks(tx, id);
    return id;
  });
}

export async function loadDevelopmentDonorSuggestions(now = new Date()) {
  const today = chicagoToday(now);
  const [targets, overdue, recentFindings, individualDonors] =
    await Promise.all([
      loadFunderTargets(now),
      db.execute<{
        id: string;
        name: string;
        owner_name: string | null;
        count: number;
      }>(sql`
      SELECT o.id, o.name, NULLIF(concat_ws(' ', u.first_name, u.last_name), '') AS owner_name, count(*)::int AS count
      FROM organizations o
      JOIN tasks t ON t.organization_ids @> ARRAY[o.id]::text[]
      LEFT JOIN users u ON u.id = o.owner_user_id AND u.archived_at IS NULL
      WHERE o.archived_at IS NULL AND NOT o.anonymous AND o.active_status IS DISTINCT FROM 'defunct' AND t.status IN ('open','waiting') AND t.due_date < ${today}::date
      GROUP BY o.id, o.name, u.first_name, u.last_name
      ORDER BY count(*) DESC LIMIT 12
    `),
      db.execute<{ id: string; name: string; owner_name: string | null }>(sql`
      SELECT DISTINCT o.id, o.name, NULLIF(concat_ws(' ', u.first_name, u.last_name), '') AS owner_name
      FROM funder_findings f JOIN organizations o ON o.id = f.organization_id
      JOIN media_mentions m ON m.id = f.media_mention_id AND NOT m.dismissed
      LEFT JOIN users u ON u.id = o.owner_user_id AND u.archived_at IS NULL
      LEFT JOIN fundraising_finding_reviews r ON r.finding_id = f.media_mention_id AND r.kind = 'media'
      WHERE o.archived_at IS NULL AND NOT o.anonymous AND o.active_status IS DISTINCT FROM 'defunct' AND f.discovered_at >= ${now.toISOString()}::timestamptz - interval '7 days'
        AND r.review IS DISTINCT FROM 'dismissed' AND f.category IN ('funding_opportunity','strategy_priorities','leadership_staff')
      UNION
      SELECT o.id, o.name, NULLIF(concat_ws(' ', u.first_name, u.last_name), '') AS owner_name
      FROM grant_leads g JOIN organizations o ON o.id = g.target_organization_id
      LEFT JOIN users u ON u.id = o.owner_user_id AND u.archived_at IS NULL
      LEFT JOIN fundraising_finding_reviews r ON r.finding_id = g.id AND r.kind = 'grant_lead'
      WHERE o.archived_at IS NULL AND NOT o.anonymous AND o.active_status IS DISTINCT FROM 'defunct' AND g.status IN ('new','claimed')
        AND g.created_at >= ${now.toISOString()}::timestamptz - interval '7 days'
        AND r.review IS DISTINCT FROM 'dismissed'
      ORDER BY name LIMIT 12
    `),
      db.execute<{
        kind: "person" | "household";
        id: string;
        name: string;
        owner_name: string | null;
        has_ask: boolean;
        overdue: number;
      }>(sql`
      WITH other_donors AS (
        SELECT 'person' AS kind, id, COALESCE(NULLIF(full_name, ''), concat_ws(' ', first_name, last_name)) AS name, owner_user_id
        FROM people WHERE archived_at IS NULL AND NOT anonymous
        UNION ALL
        SELECT 'household', id, name, NULL FROM households WHERE archived_at IS NULL
      ), ask_donors AS (
        SELECT DISTINCT 'person' AS kind, individual_giver_person_id AS id
        FROM opportunities_and_pledges
        WHERE individual_giver_person_id IS NOT NULL AND archived_at IS NULL AND write_off_of_pledge_id IS NULL
          AND loan_or_grant = 'grant' AND status IN ('open', 'pledge')
        UNION ALL
        SELECT DISTINCT 'household', household_id FROM opportunities_and_pledges
        WHERE household_id IS NOT NULL AND archived_at IS NULL AND write_off_of_pledge_id IS NULL
          AND loan_or_grant = 'grant' AND status IN ('open', 'pledge')
      ), overdue_tasks AS (
        SELECT 'person' AS kind, unnest(person_ids) AS id FROM tasks WHERE status IN ('open','waiting') AND due_date < ${today}::date
        UNION ALL
        SELECT 'household', unnest(household_ids) FROM tasks WHERE status IN ('open','waiting') AND due_date < ${today}::date
      ), task_counts AS (
        SELECT kind, id, count(*)::int AS overdue FROM overdue_tasks GROUP BY kind, id
      )
      SELECT d.kind, d.id, d.name, NULLIF(concat_ws(' ', u.first_name, u.last_name), '') AS owner_name,
             a.id IS NOT NULL AS has_ask, COALESCE(t.overdue, 0) AS overdue
      FROM other_donors d
      LEFT JOIN ask_donors a USING (kind, id)
      LEFT JOIN task_counts t USING (kind, id)
      LEFT JOIN users u ON u.id = d.owner_user_id AND u.archived_at IS NULL
      WHERE (a.id IS NOT NULL OR t.id IS NOT NULL) AND d.name <> ''
      ORDER BY overdue DESC, has_ask DESC, d.name LIMIT 12
    `),
    ]);
  type DonorKind = "organization" | "person" | "household";
  const candidates = new Map<
    string,
    {
      id: string;
      kind: DonorKind;
      name: string;
      reason: string;
      ownerName: string | null;
      priority: number;
    }
  >();
  function add(
    id: string,
    name: string,
    ownerName: string | null,
    reason: string,
    priority: number,
    kind: DonorKind = "organization",
  ) {
    const key = kind + ":" + id;
    const current = candidates.get(key);
    candidates.set(
      key,
      current
        ? {
            ...current,
            reason: current.reason + " · " + reason,
            priority: current.priority + priority,
          }
        : { id, kind, name, ownerName, reason, priority },
    );
  }
  for (const target of targets) {
    if (target.cadence === "weekly")
      add(
        target.id,
        target.name,
        target.ownerName,
        target.reason,
        target.priority,
      );
  }
  for (const row of overdue.rows)
    add(
      row.id,
      row.name,
      row.owner_name,
      row.count + (row.count === 1 ? " overdue task" : " overdue tasks"),
      5,
    );
  for (const row of recentFindings.rows)
    add(row.id, row.name, row.owner_name, "New funder update", 3);
  for (const row of individualDonors.rows) {
    if (row.has_ask)
      add(
        row.id,
        row.name,
        row.owner_name,
        "Open opportunity or outstanding pledge",
        3,
        row.kind,
      );
    if (row.overdue)
      add(
        row.id,
        row.name,
        row.owner_name,
        row.overdue + (row.overdue === 1 ? " overdue task" : " overdue tasks"),
        5,
        row.kind,
      );
  }
  return [...candidates.values()]
    .sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name))
    .slice(0, 12)
    .map(({ priority, ...row }) => row);
}
