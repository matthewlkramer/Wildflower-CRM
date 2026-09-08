import express, { Router, type IRouter } from "express";
import { db } from "@workspace/db";
import {
  emails as emailsTable,
  households,
  newsletterCampaigns,
  newsletterContacts,
  newsletterEngagement,
  organizations,
  paymentIntermediaries,
  people,
} from "@workspace/db/schema";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { ListNewsletterEngagementQueryParams } from "@workspace/api-zod";
import { requireAuth } from "../middlewares/requireAuth";
import { requireAdmin } from "../lib/archive";
import { recordAudit } from "../lib/audit";
import {
  asyncHandler,
  notFound,
  paramId,
  parseBoolQuery,
  parseOrBadRequest,
  parsePagination,
} from "../lib/helpers";
import { parseNewsletterWorkbook } from "../lib/newsletterWorkbook";
import { compareNewsletterWorkbookToCrm } from "../lib/newsletterImportComparison";

const router: IRouter = Router();
router.use(requireAuth);

router.get(
  "/newsletter-overview",
  asyncHandler(async (_req, res) => {
    const [audienceRows, campaignRows] = await Promise.all([
      db
        .select({
          currentSubscribers: sql<number>`count(*) filter (where ${newsletterContacts.sourceCurrentSubscriber})::int`,
          linkedCurrentSubscribers: sql<number>`count(*) filter (where ${newsletterContacts.sourceCurrentSubscriber} and ${newsletterContacts.emailId} is not null)::int`,
          unsubscribeEvidence: sql<number>`count(*) filter (where ${newsletterContacts.sourceUnsubscribed})::int`,
          bounceEvidence: sql<number>`count(*) filter (where ${newsletterContacts.sourceBounced})::int`,
        })
        .from(newsletterContacts),
      db
        .select({
          id: newsletterCampaigns.id,
          subject: newsletterCampaigns.subject,
          sentAt: newsletterCampaigns.sentAt,
          sentTimeText: newsletterCampaigns.sentTimeText,
          previewUrl: newsletterCampaigns.previewUrl,
          openRate: newsletterCampaigns.openRate,
          clickRate: newsletterCampaigns.clickRate,
          trackedRecipientCount: sql<number>`count(${newsletterEngagement.normalizedEmail})::int`,
          openedCount: sql<number>`count(*) filter (where ${newsletterEngagement.opened})::int`,
          clickedCount: sql<number>`count(*) filter (where ${newsletterEngagement.clicked})::int`,
          linkedCount: sql<number>`count(*) filter (where ${newsletterEngagement.emailId} is not null)::int`,
        })
        .from(newsletterCampaigns)
        .leftJoin(
          newsletterEngagement,
          eq(newsletterEngagement.campaignId, newsletterCampaigns.id),
        )
        .groupBy(newsletterCampaigns.id)
        .orderBy(desc(newsletterCampaigns.sentAt)),
    ]);
    const audience = audienceRows[0] ?? {
      currentSubscribers: 0,
      linkedCurrentSubscribers: 0,
      unsubscribeEvidence: 0,
      bounceEvidence: 0,
    };
    res.json({
      audience: {
        ...audience,
        unmatchedCurrentSubscribers:
          Number(audience.currentSubscribers) -
          Number(audience.linkedCurrentSubscribers),
      },
      campaigns: campaignRows.map((row) => ({
        ...row,
        openRate: row.openRate === null ? null : Number(row.openRate),
        clickRate: row.clickRate === null ? null : Number(row.clickRate),
      })),
    });
  }),
);

router.get(
  "/newsletter-campaigns/:id/engagement",
  asyncHandler(async (req, res) => {
    const campaignId = paramId(req);
    const exists = await db
      .select({ id: newsletterCampaigns.id })
      .from(newsletterCampaigns)
      .where(eq(newsletterCampaigns.id, campaignId))
      .then((rows) => rows[0]);
    if (!exists) return notFound(res, "newsletter campaign");

    const q = parseOrBadRequest(
      ListNewsletterEngagementQueryParams,
      req.query,
      res,
    );
    if (!q) return;
    const { limit, page, offset } = parsePagination(q);
    const filters: SQL[] = [eq(newsletterEngagement.campaignId, campaignId)];
    if (q.search) {
      const term = `%${q.search.trim()}%`;
      const match = or(
        ilike(newsletterEngagement.email, term),
        ilike(newsletterEngagement.firstName, term),
        ilike(newsletterEngagement.lastName, term),
        ilike(people.fullName, term),
        ilike(organizations.name, term),
        ilike(households.name, term),
        ilike(paymentIntermediaries.name, term),
      );
      if (match) filters.push(match);
    }
    const opened = parseBoolQuery(req, "opened");
    const clicked = parseBoolQuery(req, "clicked");
    const linked = parseBoolQuery(req, "linked");
    if (opened !== undefined)
      filters.push(eq(newsletterEngagement.opened, opened));
    if (clicked !== undefined)
      filters.push(eq(newsletterEngagement.clicked, clicked));
    if (linked !== undefined) {
      filters.push(
        linked
          ? isNotNull(newsletterEngagement.emailId)
          : isNull(newsletterEngagement.emailId),
      );
    }
    const where = and(...filters);
    const base = db
      .select({
        campaignId: newsletterEngagement.campaignId,
        email: newsletterEngagement.email,
        firstName: newsletterEngagement.firstName,
        lastName: newsletterEngagement.lastName,
        deliveredAt: newsletterEngagement.deliveredAt,
        opened: newsletterEngagement.opened,
        lastOpenedAt: newsletterEngagement.lastOpenedAt,
        totalOpens: newsletterEngagement.totalOpens,
        clicked: newsletterEngagement.clicked,
        lastClickedAt: newsletterEngagement.lastClickedAt,
        totalClicks: newsletterEngagement.totalClicks,
        clickedLinks: newsletterEngagement.clickedLinks,
        linkedRecordType: sql<
          | "person"
          | "organization"
          | "household"
          | "payment_intermediary"
          | null
        >`case
          when ${emailsTable.personId} is not null then 'person'
          when ${emailsTable.organizationId} is not null then 'organization'
          when ${emailsTable.householdId} is not null then 'household'
          when ${emailsTable.paymentIntermediaryId} is not null then 'payment_intermediary'
          else null end`,
        linkedRecordId: sql<
          string | null
        >`coalesce(${emailsTable.personId}, ${emailsTable.organizationId}, ${emailsTable.householdId}, ${emailsTable.paymentIntermediaryId})`,
        linkedRecordName: sql<string | null>`coalesce(
          ${people.fullName},
          nullif(trim(concat_ws(' ', ${people.firstName}, ${people.lastName})), ''),
          ${organizations.name},
          ${households.name},
          ${paymentIntermediaries.name}
        )`,
      })
      .from(newsletterEngagement)
      .leftJoin(emailsTable, eq(emailsTable.id, newsletterEngagement.emailId))
      .leftJoin(people, eq(people.id, emailsTable.personId))
      .leftJoin(organizations, eq(organizations.id, emailsTable.organizationId))
      .leftJoin(households, eq(households.id, emailsTable.householdId))
      .leftJoin(
        paymentIntermediaries,
        eq(paymentIntermediaries.id, emailsTable.paymentIntermediaryId),
      )
      .where(where);
    const countBase = db
      .select({ value: count() })
      .from(newsletterEngagement)
      .leftJoin(emailsTable, eq(emailsTable.id, newsletterEngagement.emailId))
      .leftJoin(people, eq(people.id, emailsTable.personId))
      .leftJoin(organizations, eq(organizations.id, emailsTable.organizationId))
      .leftJoin(households, eq(households.id, emailsTable.householdId))
      .leftJoin(
        paymentIntermediaries,
        eq(paymentIntermediaries.id, emailsTable.paymentIntermediaryId),
      )
      .where(where);
    const [data, [{ value: total } = { value: 0 }]] = await Promise.all([
      base
        .orderBy(
          desc(newsletterEngagement.clicked),
          desc(newsletterEngagement.totalOpens),
          asc(newsletterEngagement.email),
        )
        .limit(limit)
        .offset(offset),
      countBase,
    ]);
    res.json({ data, pagination: { page, limit, total: Number(total) } });
  }),
);

router.post(
  "/newsletter-imports/spreadsheet",
  express.raw({
    type: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/octet-stream",
    ],
    limit: "25mb",
  }),
  asyncHandler(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res
        .status(400)
        .json({
          error: "validation_error",
          message: "Upload a non-empty .xlsx workbook.",
        });
      return;
    }

    let parsed: ReturnType<typeof parseNewsletterWorkbook>;
    try {
      parsed = parseNewsletterWorkbook(req.body);
    } catch (error) {
      res.status(400).json({
        error: "invalid_workbook",
        message:
          error instanceof Error
            ? error.message
            : "Could not read the workbook.",
      });
      return;
    }

    const result = await db.transaction(async (tx) => {
      const [crmEmails, crmPeople] = await Promise.all([
        tx
          .select({
            id: emailsTable.id,
            email: emailsTable.email,
            personId: emailsTable.personId,
          })
          .from(emailsTable),
        tx
          .select({
            id: people.id,
            firstName: people.firstName,
            lastName: people.lastName,
            fullName: people.fullName,
            newsletter: people.newsletter,
            unsubscribedToNewsletter: people.unsubscribedToNewsletter,
          })
          .from(people),
      ]);
      const emailByAddress = new Map(
        crmEmails.map((row) => [row.email.trim().toLowerCase(), row]),
      );
      const comparison = compareNewsletterWorkbookToCrm(
        parsed.contacts,
        crmEmails,
        crmPeople,
      );

      await tx.update(newsletterContacts).set({
        sourceCurrentSubscriber: false,
        sourceUnsubscribed: false,
        sourceBounced: false,
        unsubscribeEvidence: null,
        bounceEvidence: null,
        updatedAt: new Date(),
      });

      const chunk = <T>(values: T[], size = 300): T[][] => {
        const result: T[][] = [];
        for (let index = 0; index < values.length; index += size) {
          result.push(values.slice(index, index + size));
        }
        return result;
      };

      for (const batch of chunk(parsed.campaigns)) {
        await tx
          .insert(newsletterCampaigns)
          .values(
            batch.map((row) => ({
              ...row,
              openRate: row.openRate === null ? null : String(row.openRate),
              clickRate: row.clickRate === null ? null : String(row.clickRate),
            })),
          )
          .onConflictDoUpdate({
            target: newsletterCampaigns.id,
            set: {
              subject: sql`excluded.subject`,
              sentAt: sql`excluded.sent_at`,
              sentTimeText: sql`excluded.sent_time_text`,
              previewUrl: sql`excluded.preview_url`,
              openRate: sql`excluded.open_rate`,
              clickRate: sql`excluded.click_rate`,
              sourceSheet: sql`excluded.source_sheet`,
              updatedAt: new Date(),
            },
          });
      }

      for (const batch of chunk(parsed.contacts)) {
        await tx
          .insert(newsletterContacts)
          .values(
            batch.map((row) => ({
              ...row,
              emailId: emailByAddress.get(row.normalizedEmail)?.id ?? null,
            })),
          )
          .onConflictDoUpdate({
            target: newsletterContacts.normalizedEmail,
            set: {
              email: sql`excluded.email`,
              firstName: sql`excluded.first_name`,
              lastName: sql`excluded.last_name`,
              emailId: sql`excluded.email_id`,
              sourceCurrentSubscriber: sql`excluded.source_current_subscriber`,
              sourceUnsubscribed: sql`excluded.source_unsubscribed`,
              sourceBounced: sql`excluded.source_bounced`,
              unsubscribeEvidence: sql`excluded.unsubscribe_evidence`,
              bounceEvidence: sql`excluded.bounce_evidence`,
              updatedAt: new Date(),
            },
          });
      }

      for (const batch of chunk(parsed.engagement)) {
        await tx
          .insert(newsletterEngagement)
          .values(
            batch.map((row) => ({
              ...row,
              emailId: emailByAddress.get(row.normalizedEmail)?.id ?? null,
            })),
          )
          .onConflictDoUpdate({
            target: [
              newsletterEngagement.campaignId,
              newsletterEngagement.normalizedEmail,
            ],
            set: {
              email: sql`excluded.email`,
              emailId: sql`excluded.email_id`,
              firstName: sql`excluded.first_name`,
              lastName: sql`excluded.last_name`,
              deliveredAt: sql`excluded.delivered_at`,
              opened: sql`excluded.opened`,
              lastOpenedAt: sql`excluded.last_opened_at`,
              totalOpens: sql`excluded.total_opens`,
              clicked: sql`excluded.clicked`,
              lastClickedAt: sql`excluded.last_clicked_at`,
              totalClicks: sql`excluded.total_clicks`,
              clickedLinks: sql`excluded.clicked_links`,
              updatedAt: new Date(),
            },
          });
      }

      const linkedAudienceRecords = parsed.contacts.filter((row) =>
        emailByAddress.has(row.normalizedEmail),
      ).length;
      const summary = {
        campaigns: parsed.campaigns.length,
        audienceRecords: parsed.contacts.length,
        engagementRecords: parsed.engagement.length,
        linkedAudienceRecords,
        unmatchedAudienceRecords:
          parsed.contacts.length - linkedAudienceRecords,
        peopleSubscribed: 0,
        peopleUnsubscribed: 0,
        bouncedEmailsInvalidated: 0,
        operationalRecordsChanged: false,
        subscriptionDifferences: {
          total: comparison.subscriptionDifferences.length,
          examples: comparison.subscriptionDifferences.slice(0, 25),
        },
        emailDifferences: {
          total: comparison.emailDifferences.length,
          examples: comparison.emailDifferences.slice(0, 25),
        },
      };
      await recordAudit(tx, req, {
        action: "bulk_update",
        entityType: "newsletter_import",
        entityId: "flodesk-workbook",
        summary:
          "Imported Flodesk newsletter evidence without changing CRM subscription or email fields",
        metadata: {
          campaigns: summary.campaigns,
          audienceRecords: summary.audienceRecords,
          engagementRecords: summary.engagementRecords,
          linkedAudienceRecords: summary.linkedAudienceRecords,
          unmatchedAudienceRecords: summary.unmatchedAudienceRecords,
          subscriptionDifferences: summary.subscriptionDifferences.total,
          emailDifferences: summary.emailDifferences.total,
          operationalRecordsChanged: false,
        },
      });
      return summary;
    });
    res.json(result);
  }),
);

export default router;
