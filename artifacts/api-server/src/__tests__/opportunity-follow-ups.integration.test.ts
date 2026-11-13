import express from "express";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { eq } from "drizzle-orm";

const { owner, organization, opportunity } = vi.hoisted(() => {
  const run = "follow-up-" + Date.now();
  return { owner: run + "-owner", organization: run + "-org", opportunity: run + "-opp" };
});
vi.mock("../middlewares/requireAuth", () => ({
  requireAuth: (req: { appUser?: object }, _res: unknown, next: () => void) => {
    req.appUser = { id: owner, role: "team_member" };
    next();
  },
}));

import router from "../routes/opportunityFollowUps";
import { db, opportunitiesAndPledges, organizations, users } from "@workspace/db";
import { checkInAfter } from "../lib/opportunityFollowUps";
import { chicagoToday } from "../lib/effectiveProjectedCloseDate";

let server: Server;
let url: string;
beforeAll(async () => {
  await db.insert(users).values({ id: owner, clerkId: owner, email: owner + "@example.org" });
  await db.insert(organizations).values({ id: organization, name: "Example Funder" });
  await db.insert(opportunitiesAndPledges).values({ id: opportunity, name: "Growth", organizationId: organization, ownerUserId: owner });
  const app = express().use(express.json()).use(router);
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await db.delete(opportunitiesAndPledges).where(eq(opportunitiesAndPledges.id, opportunity));
  await db.delete(organizations).where(eq(organizations.id, organization));
  await db.delete(users).where(eq(users.id, owner));
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function request(path: string, method = "GET", body?: object) {
  const response = await fetch(url + path, {
    method, body: body ? JSON.stringify(body) : undefined, headers: { "Content-Type": "application/json" },
  });
  const data = await response.json();
  expect(response.ok, JSON.stringify(data)).toBe(true);
  return data;
}

it("starts a funder check-in only after the prerequisite is sent and keeps shared/read and due dates distinct", async () => {
  const path = `/opportunities-and-pledges/${opportunity}/follow-ups`;
  const shared = await request(path, "POST", { kind: "shared", title: "Outcomes pre-read", readStatus: "unread", evidenceNote: "Shared in advance." });
  const plan = await request(path, "POST", { kind: "ours", title: "Send growth plan", evidenceNote: "Promised in the meeting." });
  const waiting = await request(path, "POST", { kind: "waiting", title: "Evaluate fit", ownerName: "Pat Funder",
    dependencyId: plan.id, checkInDays: 14, externalDueDate: "2030-03-12", evidenceNote: "Funder volunteered." });
  expect(shared).toMatchObject({ status: "shared", readStatus: "unread" });
  expect(waiting).toMatchObject({ status: "blocked", checkInOn: null, pointPersonId: owner });
  const sent = checkInAfter(chicagoToday(), -14);
  await request(`/opportunity-follow-ups/${plan.id}`, "PATCH", { action: "sent", date: sent });
  const due = await request("/opportunity-follow-ups/due");
  expect(due).toContainEqual(expect.objectContaining({ id: waiting.id, status: "due", checkInOn: chicagoToday(), externalDueDate: "2030-03-12" }));
  const checked = await request(`/opportunity-follow-ups/${waiting.id}`, "PATCH", { action: "checked_in" });
  expect(checked).toMatchObject({ status: "waiting", checkInOn: checkInAfter(chicagoToday(), 14) });
  await request(`/opportunity-follow-ups/${waiting.id}`, "PATCH", { action: "resolved" });
  expect((await request(path)).items).toContainEqual(expect.objectContaining({ id: waiting.id, status: "resolved" }));
});
