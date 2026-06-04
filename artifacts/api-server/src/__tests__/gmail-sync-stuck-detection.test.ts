import { beforeEach, describe, expect, it, vi } from "vitest";
import { emailSyncState } from "@workspace/db/schema";

// ── Stall detection: the consecutive no-progress counter ─────────────────────
//
// Exercises syncUserGmail end-to-end (with Gmail + DB mocked) to assert the
// `noProgressRuns` bookkeeping on email_sync_state:
//   - a run that finishes with per-message errors (cursor held, no forward
//     progress) bumps the counter via a SQL increment
//   - a clean run (here: a quiet idle mailbox with no new mail) resets it to 0
//
// The reset-on-clean-run path is what keeps healthy idle mailboxes off the
// admin "stuck" radar — the whole point of the feature.

const captured = vi.hoisted(() => ({
  cursorUpdates: [] as Array<Record<string, unknown>>,
}));

const env = vi.hoisted(() => ({
  // The state row syncUserGmail reads back after its provisioning upsert.
  stateRow: null as Record<string, unknown> | null,
  // FIFO queue of pages returned by successive listHistory calls.
  pages: [] as Array<{
    history: Array<{ messagesAdded?: { message: { id: string; threadId: string } }[] }>;
    nextPageToken?: string;
    historyId: string;
  }>,
  // Ids that getMessage should fail transiently on.
  transientIds: new Set<string>(),
}));

vi.mock("@workspace/db", () => ({
  db: {
    insert: () => ({
      values: () => ({ onConflictDoNothing: () => Promise.resolve() }),
    }),
    select: () => ({
      from: (table: unknown) => ({
        // Only the state read-back returns a row; owner-mode lookup and
        // filterUnseenIds both resolve to [] (so every id is "unseen").
        where: () =>
          Promise.resolve(
            table === emailSyncState && env.stateRow ? [env.stateRow] : [],
          ),
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
  },
}));

vi.mock("../lib/googleTokenStore", () => ({
  getValidGoogleAccessTokenForUser: vi.fn(async () => ({
    userId: "user-1",
    googleEmail: "owner@wildflowerschools.org",
    accessToken: "token",
    scope: "scope",
    expiresAt: new Date(Date.now() + 3_600_000),
  })),
}));

vi.mock("../lib/gmail", async (importActual) => {
  const actual = await importActual<typeof import("../lib/gmail")>();
  return {
    ...actual,
    listHistory: vi.fn(async () => {
      const page = env.pages.shift();
      if (!page) throw new Error("test: listHistory called with no queued page");
      return page;
    }),
    getMessage: vi.fn(async (_token: string, id: string) => {
      if (env.transientIds.has(id)) throw new Error("test: transient 503");
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

import { syncUserGmail } from "../lib/gmailSync";

function baseState(noProgressRuns: number): Record<string, unknown> {
  return {
    mailboxUserId: "user-1",
    lastHistoryId: "100",
    lastSyncedAt: null,
    lastError: null,
    bootstrapCompletedAt: new Date(),
    bootstrapPageToken: null,
    incrementalPageToken: null,
    backfillCompletedAt: null,
    noProgressRuns,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// The terminal write is the only cursor update that carries a noProgressRuns key.
function terminalUpdate() {
  return captured.cursorUpdates.find((u) => "noProgressRuns" in u);
}

beforeEach(() => {
  captured.cursorUpdates.length = 0;
  env.pages = [];
  env.transientIds = new Set<string>();
});

describe("Gmail sync stall detection", () => {
  it("increments noProgressRuns when a run finishes with errors", async () => {
    env.stateRow = baseState(2);
    // One history page with one message id that fails transiently → the
    // incremental pass holds its cursor and the run reports an error.
    env.transientIds.add("msg-stuck");
    env.pages = [
      {
        history: [{ messagesAdded: [{ message: { id: "msg-stuck", threadId: "t" } }] }],
        historyId: "101",
      },
    ];

    const out = await syncUserGmail("user-1");
    expect(out.ok).toBe(true);
    expect(out.report?.errors).toBe(1);

    const term = terminalUpdate();
    expect(term).toBeDefined();
    // A SQL increment, not the literal 0 reset.
    expect(term!.noProgressRuns).not.toBe(0);
    expect(typeof term!.noProgressRuns).toBe("object");
  });

  it("resets noProgressRuns to 0 on a clean (idle, no new mail) run", async () => {
    env.stateRow = baseState(4);
    // A quiet mailbox: history page with no added messages, fully drained.
    env.pages = [{ history: [], historyId: "105" }];

    const out = await syncUserGmail("user-1");
    expect(out.ok).toBe(true);
    expect(out.report?.errors).toBe(0);

    const term = terminalUpdate();
    expect(term).toBeDefined();
    expect(term!.noProgressRuns).toBe(0);
    expect(term!.lastError).toBeNull();
  });
});
