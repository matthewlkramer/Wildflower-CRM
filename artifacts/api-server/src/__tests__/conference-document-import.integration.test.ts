import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq, inArray } from "drizzle-orm";
import * as XLSX from "xlsx";

const HAS_DB = !!process.env.DATABASE_URL;
const run = `docimport_${Date.now()}`;
const userId = `${run}_user`;
const eventId = `${run}_event`;
const orgId = `${run}_org`;
const p1 = `${run}_p1`;
const auth = vi.hoisted(() => ({ id: "", role: "admin", signedIn: true }));
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (
    req: { appUser?: unknown },
    res: express.Response,
    next: () => void,
  ) => {
    if (!auth.signedIn) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.appUser = { id: auth.id, role: auth.role };
    next();
  },
}));
let schema: typeof import("@workspace/db");
let server: Server;
let base: string;
async function post(path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}
const names = {
  known: `${run} Alex Chen`,
  duplicate: `${run} Sam Avery`,
  new: `${run} Robin Ames`,
  foundation: `${run} Jamie Reed`,
};
beforeAll(async () => {
  if (!HAS_DB) return;
  schema = await import("@workspace/db");
  auth.id = userId;
  await schema.db.insert(schema.users).values({
    id: userId,
    clerkId: userId,
    email: `${run}@example.org`,
    role: "admin",
  });
  await schema.db.insert(schema.organizations).values({
    id: orgId,
    name: `${run} Civic Alliance`,
    historicalNames: [`${run} Old Alliance`],
  });
  await schema.db.insert(schema.people).values([
    { id: p1, fullName: names.known },
    { id: `${run}_p2`, fullName: names.duplicate },
    { id: `${run}_p3`, fullName: names.duplicate },
  ]);
  await schema.db.insert(schema.peopleEntityRoles).values({
    id: `${run}_role`,
    personId: p1,
    entityType: "organization",
    organizationId: orgId,
  });
  await schema.db.insert(schema.organizations).values({
    id: `${run}_other_org`,
    name: `${run} Education Foundation`,
    ownerUserId: userId,
  });
  await schema.db.insert(schema.peopleEntityRoles).values([
    {
      id: `${run}_role_p2`,
      personId: `${run}_p2`,
      entityType: "organization",
      organizationId: orgId,
    },
    {
      id: `${run}_role_p3`,
      personId: `${run}_p3`,
      entityType: "organization",
      organizationId: `${run}_other_org`,
    },
  ]);
  await schema.db
    .insert(schema.conferenceTypes)
    .values({ id: `${run}_type`, displayName: run });
  await schema.db
    .insert(schema.conferenceEvents)
    .values({ id: eventId, conferenceTypeId: `${run}_type`, year: 2090 });
  await schema.db.insert(schema.conferenceAttendance).values({
    id: `${run}_attendance`,
    conferenceEventId: eventId,
    personId: p1,
    status: "confirmed",
    role: "Speaker",
    sourceType: "manual",
    evidenceNote: "Richer verified speaker evidence",
  });
  const { default: router } = await import("../routes/conferences");
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(router);
  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => res.status(500).json({ error: error.message }),
  );
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60000);
afterAll(async () => {
  if (!HAS_DB) return;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  const created = await schema.db
    .select({ id: schema.people.id })
    .from(schema.people)
    .where(eq(schema.people.ownerUserId, userId));
  await schema.db
    .delete(schema.conferenceEvents)
    .where(eq(schema.conferenceEvents.id, eventId));
  await schema.db
    .delete(schema.conferenceTypes)
    .where(eq(schema.conferenceTypes.id, `${run}_type`));
  await schema.db
    .delete(schema.people)
    .where(
      inArray(schema.people.id, [
        p1,
        `${run}_p2`,
        `${run}_p3`,
        ...created.map((p) => p.id),
      ]),
    );
  await schema.db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  await schema.db
    .delete(schema.organizations)
    .where(eq(schema.organizations.ownerUserId, userId));
  await schema.db
    .delete(schema.auditLog)
    .where(eq(schema.auditLog.actorUserId, userId));
  await schema.db.delete(schema.users).where(eq(schema.users.id, userId));
}, 60000);

describe.skipIf(!HAS_DB)(
  "document import through authenticated HTTP and PostgreSQL",
  () => {
    it("previews CSV/XLSX, stages once, reviews mixed outcomes, retries partial failure and preserves richer records", async () => {
      const matrix = [
        ["Display", "Organization", "Title"],
        [names.known, `${run} Old Alliance`, "Director"],
        [names.duplicate, "", "Officer"],
        [names.new, `${run} Civic Alliance`, "Program lead"],
        [names.foundation, `${run} Mystery Foundation`, "Trustee"],
        [`${run} Other`, "Unknown nonprofit", ""],
        [names.known, `${run} Old Alliance`, "Director"],
        ["", "Bad row", ""],
        [names.foundation, `${run} Mystery Foundation`, "Trustee"],
      ];
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(
        workbook,
        XLSX.utils.aoa_to_sheet(matrix),
        "Directory",
      );
      const fileBase64 = (
        XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer
      ).toString("base64");
      const csvText = matrix.map((r) => r.join(",")).join("\n");
      const mapping = { name: 0, organization: 1, title: 2 };
      auth.signedIn = false;
      expect(
        (await post("/conference-import-preview", { csvText })).status,
      ).toBe(401);
      auth.signedIn = true;
      auth.role = "read_only";
      expect(
        (await post("/conference-import-preview", { csvText })).status,
      ).toBe(403);
      auth.role = "admin";
      expect(
        (
          await post("/conference-import-preview", {
            filename: "directory.xlsx",
            fileBase64,
          })
        ).body.rowCount,
      ).toBe(8);
      expect(
        (await post("/conference-import-preview", { csvText })).body.headers,
      ).toEqual(matrix[0]);
      expect(
        (await post("/conference-import-preview", { csvText: 'Name\n"bad' }))
          .status,
      ).toBe(400);
      const path = `/conference-events/${eventId}/imports`;
      const [a, concurrent] = await Promise.all([
        post(path, { csvText, columns: mapping }),
        post(path, { csvText, columns: mapping }),
      ]);
      expect(a.status).toBe(200);
      expect(concurrent.body.id).toBe(a.body.id);
      expect(
        (
          await post(path, {
            fileBase64,
            filename: "directory.xlsx",
            columns: mapping,
          })
        ).body.id,
      ).toBe(a.body.id);
      const rows = a.body.rows;
      expect(rows.map((r: any) => r.category)).toEqual([
        "reliable",
        "ambiguous",
        "new_person_existing_org",
        "other_unmatched",
        "other_unmatched",
        "reliable",
        "error",
        "other_unmatched",
      ]);
      expect(rows[0].rawCells).toEqual(matrix[1]);
      const confirmPath = `/conference-imports/${a.body.id}/confirm`;
      expect(
        (await post(confirmPath, { acceptedRowIds: ["foreign-row"] })).status,
      ).toBe(400);
      const review = await post(confirmPath, {
        acceptedRowIds: [rows[0].id, rows[2].id, rows[3].id, rows[5].id],
        rejectedRowIds: [rows[4].id, rows[6].id],
        newPeople: {
          [rows[2].id]: {
            name: names.new,
            organization: `${run} Civic Alliance`,
            title: "Program lead",
          },
          [rows[3].id]: {
            name: names.foundation,
            organization: `${run} Mystery Foundation`,
          },
        },
      });
      expect(review.body.status).toBe("staged");
      expect(review.body.rows[3].reviewError).toContain("explicit evidence");
      expect(review.body.rows.map((r: any) => r.disposition)).toEqual([
        "accept",
        "pending",
        "accept",
        "pending",
        "skip",
        "accept",
        "skip",
        "pending",
      ]);
      const retry = await post(confirmPath, {
        acceptedRowIds: [rows[1].id, rows[3].id, rows[7].id],
        personOverrides: { [rows[1].id]: `${run}_p2` },
        newPeople: {
          [rows[3].id]: {
            name: names.foundation,
            organization: `${run} Mystery Foundation`,
            foundationEvidence:
              "Reviewed synthetic registry: explicitly a foundation.",
          },
          [rows[7].id]: {
            name: names.foundation,
            organization: `${run} Mystery Foundation`,
            foundationEvidence:
              "Reviewed synthetic registry: explicitly a foundation.",
          },
        },
      });
      expect(retry.body.status).toBe("confirmed");
      expect(retry.body.rows[3].category).toBe("new_foundation_person_org");
      const attendance = await schema.db
        .select()
        .from(schema.conferenceAttendance)
        .where(eq(schema.conferenceAttendance.conferenceEventId, eventId));
      expect(attendance).toHaveLength(4);
      expect(attendance.find((r) => r.personId === p1)).toMatchObject({
        registrationListed: true,
        status: "confirmed",
        role: "Speaker",
        sourceType: "manual",
        evidenceNote: "Richer verified speaker evidence",
      });
      expect(
        attendance
          .filter((r) => r.personId !== p1)
          .every((r) => r.registrationListed && r.status === "possible"),
      ).toBe(true);
      expect(
        await schema.db
          .select()
          .from(schema.people)
          .where(eq(schema.people.fullName, names.foundation)),
      ).toHaveLength(1);
      expect(
        await schema.db
          .select()
          .from(schema.organizations)
          .where(eq(schema.organizations.name, `${run} Mystery Foundation`)),
      ).toHaveLength(1);
      await post(confirmPath, {});
      expect((await post(path, { csvText, columns: mapping })).body.id).toBe(
        a.body.id,
      );
      const reordered = matrix.map((r, i) => (i ? r : r)).reverse();
      const header = reordered.pop()!;
      reordered.unshift(header);
      const other = await post(path, {
        csvText: reordered.map((r) => r.join(",")).join("\n"),
        columns: mapping,
      });
      const reliable = other.body.rows
        .filter((r: any) => r.category === "reliable")
        .map((r: any) => r.id);
      await post(`/conference-imports/${other.body.id}/confirm`, {
        acceptedRowIds: reliable,
      });
      expect(
        await schema.db
          .select()
          .from(schema.conferenceAttendance)
          .where(eq(schema.conferenceAttendance.conferenceEventId, eventId)),
      ).toHaveLength(4);
    }, 60000);
  },
);

describe.skipIf(!HAS_DB)(
  "combined affiliation and contextual candidates",
  () => {
    it("corroborates complete known suffixes and requires an explicit ambiguous person choice", async () => {
      const csvText = `Name,Displayed line\n${names.known},"Senior Director, Programs, ${run} Civic Alliance"\n${names.duplicate},"Program Officer, Unknown Foundation"`;
      const columns = { name: 0, combinedTitleOrganization: 1 };
      const preview = await post("/conference-import-preview", {
        csvText,
        columns,
      });
      expect(preview.status).toBe(200);
      expect(preview.body.rows[0]).toMatchObject({
        proposedTitle: "Senior Director, Programs",
        proposedOrganization: `${run} Civic Alliance`,
        splitNeedsReview: false,
      });
      expect(preview.body.rows[1]).toMatchObject({
        proposedOrganization: "Unknown Foundation",
        splitNeedsReview: true,
      });
      const staged = await post(`/conference-events/${eventId}/imports`, {
        csvText,
        columns,
      });
      expect(staged.status).toBe(200);
      expect(staged.body.rows[0]).toMatchObject({
        category: "reliable",
        matchedPersonId: p1,
        rawCombinedTitleOrganization: `Senior Director, Programs, ${run} Civic Alliance`,
      });
      const ambiguous = staged.body.rows[1];
      expect(ambiguous).toMatchObject({
        category: "ambiguous",
        matchedPersonId: null,
        rawOrganization: null,
        splitNeedsReview: true,
      });
      expect(ambiguous.candidatePeople.map((p: any) => p.id).sort()).toEqual([
        `${run}_p2`,
        `${run}_p3`,
      ]);
      expect(
        new Set(
          ambiguous.candidatePeople.map((p: any) => p.organizations[0].name),
        ).size,
      ).toBe(2);
      expect(
        ambiguous.candidatePeople.every(
          (p: any) => Array.isArray(p.organizations) && Array.isArray(p.emails),
        ),
      ).toBe(true);
      const chosen = ambiguous.candidatePeople[1].id;
      const lookup = await fetch(
        `${base}/conference-import-people?personId=${chosen}`,
      ).then((r) => r.json());
      expect(lookup[0].id).toBe(chosen);
      const reviewed = await post(
        `/conference-imports/${staged.body.id}/confirm`,
        {
          acceptedRowIds: [ambiguous.id],
          personOverrides: { [ambiguous.id]: chosen },
        },
      );
      expect(reviewed.body.rows[1]).toMatchObject({
        disposition: "accept",
        reviewedPersonId: chosen,
      });
      const records = await schema.db
        .select()
        .from(schema.conferenceAttendance)
        .where(eq(schema.conferenceAttendance.personId, chosen));
      expect(records).toHaveLength(1);
      expect(records[0].registrationListed).toBe(true);
      expect(
        await schema.db
          .select()
          .from(schema.organizations)
          .where(eq(schema.organizations.name, "Unknown Foundation")),
      ).toHaveLength(0);
      expect(
        (
          await post(`/conference-events/${eventId}/imports`, {
            csvText,
            columns,
          })
        ).body.id,
      ).toBe(staged.body.id);
    });
  },
);

describe.skipIf(!HAS_DB || process.env.CONFERENCE_IMPORT_BROWSER_TEST !== "1")(
  "real API browser review",
  () => {
    it("shows contextual duplicate identities and approves the selected record", async () => {
      const requireWeb = createRequire(
        new URL("../../../wildflower-crm/package.json", import.meta.url),
      );
      const { chromium } = requireWeb("@playwright/test");
      const webRoot = fileURLToPath(
        new URL("../../../wildflower-crm/", import.meta.url),
      );
      const vite = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              "../../../wildflower-crm/node_modules/vite/bin/vite.js",
              import.meta.url,
            ),
          ),
          "--host",
          "127.0.0.1",
        ],
        {
          cwd: webRoot,
          env: { ...process.env, PORT: "54122", BASE_PATH: "/" },
          stdio: "ignore",
          windowsHide: true,
        },
      );
      let browser: any;
      try {
        const url = `http://127.0.0.1:54122/e2e/fixtures/conference-import.html?eventId=${eventId}`;
        for (let i = 0; i < 100; i++) {
          try {
            if ((await fetch(url)).ok) break;
          } catch {}
          await new Promise((r) => setTimeout(r, 100));
        }
        browser = await chromium.launch({
          headless: true,
          channel: process.env.PLAYWRIGHT_BROWSER_CHANNEL || undefined,
        });
        const page = await browser.newPage();
        await page.route("**/api/**", async (route: any) => {
          const incoming = new URL(route.request().url());
          const response = await route.fetch({
            url:
              base + incoming.pathname.replace(/^\/api/, "") + incoming.search,
          });
          await route.fulfill({ response });
        });
        await page.goto(url);
        await page
          .getByLabel("Or paste CSV")
          .fill(
            `Name,Displayed line\n${names.duplicate},"Program Officer, Another Unknown Group"`,
          );
        await page
          .getByRole("button", { name: "Preview document", exact: true })
          .click();
        await page
          .getByLabel("Combined title / organization column", { exact: true })
          .selectOption("1");
        await page
          .getByRole("button", { name: "Preview mapped splits", exact: true })
          .click();
        await page
          .getByText(
            "Title: Program Officer; organization: Another Unknown Group.",
            { exact: false },
          )
          .waitFor();
        await page
          .getByRole("button", {
            name: "Stage mapped rows for review",
            exact: true,
          })
          .click();
        const candidate = `${run}_p2`;
        await page
          .getByText(`${run} Civic Alliance`, { exact: false })
          .first()
          .waitFor();
        await page
          .getByText(`${run} Education Foundation`, { exact: false })
          .first()
          .waitFor();
        await page
          .getByRole("link", {
            name: `Inspect ${names.duplicate} (${candidate})`,
            exact: true,
          })
          .waitFor();
        await page
          .getByRole("button", {
            name: `Select ${names.duplicate} (${candidate})`,
            exact: true,
          })
          .click();
        expect(
          await page
            .getByRole("link", {
              name: `Inspect selected CRM person (${candidate})`,
              exact: true,
            })
            .getAttribute("href"),
        ).toBe(`/individuals/${candidate}`);
        await page.getByLabel("Approve registration", { exact: true }).check();
        await page
          .getByRole("button", {
            name: "Apply 1 approvals and 0 rejections",
            exact: true,
          })
          .click();
        await page
          .getByRole("status")
          .filter({ hasText: "1 approved" })
          .waitFor();
        expect(
          await schema.db
            .select()
            .from(schema.conferenceAttendance)
            .where(eq(schema.conferenceAttendance.personId, candidate)),
        ).toHaveLength(1);
      } finally {
        await browser?.close();
        vite.kill();
      }
    }, 60000);
  },
);

describe.skipIf(!HAS_DB)(
  "approval rechecks combined affiliation boundaries",
  () => {
    it.each(["ambiguous", "changed"])(
      "requires explicit review when a staged split becomes %s",
      async (scenario) => {
        const organizationId = `${run}_stale_${scenario}_org`;
        const personId = `${run}_stale_${scenario}_person`;
        const organizationName = `${run} ${scenario} Harbor Foundation`;
        const personName = `${run} ${scenario} Casey Reed`;
        await schema.db
          .insert(schema.organizations)
          .values({
            id: organizationId,
            name: organizationName,
            ownerUserId: userId,
          });
        await schema.db
          .insert(schema.people)
          .values({ id: personId, fullName: personName, ownerUserId: userId });
        await schema.db
          .insert(schema.peopleEntityRoles)
          .values({
            id: `${personId}_role`,
            personId,
            entityType: "organization",
            organizationId,
          });
        const originalLine = `Director, Programs, ${organizationName}`;
        const staged = await post(`/conference-events/${eventId}/imports`, {
          csvText: `Name,Displayed line\n${personName},"${originalLine}"`,
          columns: { name: 0, combinedTitleOrganization: 1 },
        });
        expect(staged.status).toBe(200);
        const row = staged.body.rows[0];
        expect(row).toMatchObject({
          category: "reliable",
          matchedPersonId: personId,
          rawTitle: "Director, Programs",
          rawOrganization: organizationName,
          splitNeedsReview: false,
        });
        if (scenario === "changed")
          await schema.db
            .update(schema.organizations)
            .set({ name: `Programs, ${organizationName}` })
            .where(eq(schema.organizations.id, organizationId));
        else
          await schema.db
            .insert(schema.organizations)
            .values({
              id: `${organizationId}_conflict`,
              name: `Programs, ${organizationName}`,
              ownerUserId: userId,
            });
        const confirm = `/conference-imports/${staged.body.id}/confirm`;
        const blocked = await post(confirm, { acceptedRowIds: [row.id] });
        expect(blocked.status).toBe(200);
        expect(blocked.body.rows[0].disposition).toBe("pending");
        expect(blocked.body.rows[0].reviewError).toMatch(
          /Combined title\/organization.*review/i,
        );
        expect(
          await schema.db
            .select()
            .from(schema.conferenceAttendance)
            .where(eq(schema.conferenceAttendance.personId, personId)),
        ).toHaveLength(0);
        expect(blocked.body.rows[0].rawCombinedTitleOrganization).toBe(
          originalLine,
        );
        const explicit = await post(confirm, {
          acceptedRowIds: [row.id],
          personOverrides: { [row.id]: personId },
        });
        expect(explicit.body.rows[0]).toMatchObject({
          disposition: "accept",
          reviewedPersonId: personId,
          reviewError: null,
          rawCombinedTitleOrganization: originalLine,
        });
        expect(
          await schema.db
            .select()
            .from(schema.conferenceAttendance)
            .where(eq(schema.conferenceAttendance.personId, personId)),
        ).toHaveLength(1);
      },
    );
  },
);
