import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import express from "express";
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
  await schema.db
    .insert(schema.users)
    .values({
      id: userId,
      clerkId: userId,
      email: `${run}@example.org`,
      role: "admin",
    });
  await schema.db
    .insert(schema.organizations)
    .values({
      id: orgId,
      name: `${run} Civic Alliance`,
      historicalNames: [`${run} Old Alliance`],
    });
  await schema.db.insert(schema.people).values([
    { id: p1, fullName: names.known },
    { id: `${run}_p2`, fullName: names.duplicate },
    { id: `${run}_p3`, fullName: names.duplicate },
  ]);
  await schema.db
    .insert(schema.peopleEntityRoles)
    .values({
      id: `${run}_role`,
      personId: p1,
      entityType: "organization",
      organizationId: orgId,
    });
  await schema.db
    .insert(schema.conferenceTypes)
    .values({ id: `${run}_type`, displayName: run });
  await schema.db
    .insert(schema.conferenceEvents)
    .values({ id: eventId, conferenceTypeId: `${run}_type`, year: 2090 });
  await schema.db
    .insert(schema.conferenceAttendance)
    .values({
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
