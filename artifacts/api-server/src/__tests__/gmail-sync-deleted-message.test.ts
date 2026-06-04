import { beforeEach, describe, expect, it, vi } from "vitest";
import { emailSyncSkip, emailSyncState } from "@workspace/db/schema";
import type { ActiveGoogleGrant } from "../lib/googleTokenStore";
import type { EmailSyncState } from "@workspace/db/schema";

// ── Captured DB writes + mock-controlled Gmail responses ─────────────────────

const captured = vi.hoisted(() => ({
  // Payloads passed to db.update(...).set(...) — i.e. cursor writes.
  cursorUpdates: [] as Array<Record<string, unknown>>,
  // Rows passed to db.insert(emailSyncSkip).values(...).
  skipInserts: [] as Array<Record<string, unknown>>,
}));

const gmailState = vi.hoisted(() => ({
  // FIFO queue of pages returned by successive listHistory calls.
  pages: [] as Array<{
    history: Array<{ messagesAdded?: { message: { id: string; threadId: string } }[] }>;
    nextPageToken?: string;
    historyId: string;
  }>,
  // Per-id failure injection for getMessage.
  notFoundIds: new Set<string>(),
  transientIds: new Set<string>(),
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        // Used by the owner-mode lookup (.then) and filterUnseenIds (awaited).
        where: () => Promise.resolve([]),
      }),
    }),
    update: (table: unknown) => ({
      set: (payload: Record<string, unknown>) => ({
        where: () => {
          if (table === emailSyncState) captured.cursorUpdates.push(payload);
          return Promise.resolve();
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoNothing: () => {
          if (table === emailSyncSkip) captured.skipInserts.push(v);
          return Promise.resolve();
        },
      }),
    }),
  },
}));

vi.mock("../lib/gmail", async (importActual) => {
  const actual = await importActual<typeof import("../lib/gmail")>();
  return {
    ...actual,
    listHistory: vi.fn(async () => {
      const page = gmailState.pages.shift();
      if (!page) throw new Error("test: listHistory called with no queued page");
      return page;
    }),
    getMessage: vi.fn(async (_token: string, id: string) => {
      if (gmailState.notFoundIds.has(id)) {
        throw new actual.GmailNotFoundError(`/messages/${id}`);
      }
      if (gmailState.transientIds.has(id)) {
        throw new Error("test: transient 503");
      }
      return {
        id,
        threadId: "t",
        labelIds: [],
        snippet: "",
        internalDate: "0",
        payload: { headers: [], mimeType: "text/plain" },
      };
    }),
  };
});

vi.mock("../lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Imported after the mocks (vi.mock is hoisted regardless).
import { runIncrementalPass, type GmailSyncReport } from "../lib/gmailSync";

const GRANT: ActiveGoogleGrant = {
  userId: "user-1",
  googleEmail: "owner@wildflowerschools.org",
  accessToken: "token",
  scope: "scope",
  expiresAt: new Date(Date.now() + 3_600_000),
};

function makeState(): EmailSyncState {
  return {
    mailboxUserId: "user-1",
    lastHistoryId: "100",
    lastSyncedAt: null,
    lastError: null,
    bootstrapCompletedAt: new Date(),
    bootstrapPageToken: null,
    incrementalPageToken: null,
    backfillCompletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeReport(): GmailSyncReport {
  return {
    mode: "incremental",
    candidates: 0,
    matched: 0,
    skipped: 0,
    errors: 0,
    attachments: 0,
    attachmentBytes: 0,
    bootstrapCompleted: false,
    finalHistoryId: null,
  };
}

function page(ids: string[], historyId: string, nextPageToken?: string) {
  return {
    history: ids.map((id) => ({ messagesAdded: [{ message: { id, threadId: "t" } }] })),
    nextPageToken,
    historyId,
  };
}

beforeEach(() => {
  captured.cursorUpdates = [];
  captured.skipInserts = [];
  gmailState.pages = [];
  gmailState.notFoundIds = new Set();
  gmailState.transientIds = new Set();
});

describe("runIncrementalPass — deleted (404) message handling", () => {
  it("skips a 404 message and advances the cursor past it", async () => {
    gmailState.pages = [page(["dead1"], "200")];
    gmailState.notFoundIds.add("dead1");

    const report = makeReport();
    await runIncrementalPass(GRANT, makeState(), report);

    // The dead message was recorded as a permanent skip…
    expect(captured.skipInserts.map((r) => r.gmailMessageId)).toContain("dead1");
    expect(report.skipped).toBe(1);
    // …and did NOT count as a cursor-blocking error.
    expect(report.errors).toBe(0);

    // The page fully drained, so the cursor advanced to the page's
    // historyId and the incremental page token was cleared.
    const advance = captured.cursorUpdates.find((u) => "lastHistoryId" in u);
    expect(advance).toBeDefined();
    expect(advance!.lastHistoryId).toBe("200");
    expect(advance!.incrementalPageToken).toBeNull();
    expect(report.finalHistoryId).toBe("200");
  });

  it("holds the cursor on a transient (non-404) failure", async () => {
    gmailState.pages = [page(["blip1"], "200")];
    gmailState.transientIds.add("blip1");

    const report = makeReport();
    await runIncrementalPass(GRANT, makeState(), report);

    // Transient failures are NOT recorded as skips…
    expect(captured.skipInserts).toHaveLength(0);
    expect(report.errors).toBe(1);

    // …and the cursor must NOT advance — only the page token is saved so
    // the same page replays next run.
    const advanced = captured.cursorUpdates.some((u) => "lastHistoryId" in u);
    expect(advanced).toBe(false);
    expect(report.finalHistoryId).toBeNull();
  });

  it("a transient failure still holds the cursor even when a 404 is also present on the page", async () => {
    gmailState.pages = [page(["dead1", "blip1"], "200")];
    gmailState.notFoundIds.add("dead1");
    gmailState.transientIds.add("blip1");

    const report = makeReport();
    await runIncrementalPass(GRANT, makeState(), report);

    // The 404 is still recorded as a permanent skip…
    expect(captured.skipInserts.map((r) => r.gmailMessageId)).toContain("dead1");
    // …but the transient failure blocks cursor advancement.
    expect(report.errors).toBe(1);
    const advanced = captured.cursorUpdates.some((u) => "lastHistoryId" in u);
    expect(advanced).toBe(false);
  });
});
