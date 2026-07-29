from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = Path(path)
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    target.write_text(text.replace(old, new, 1), encoding="utf-8")


# Database schema + migration.
replace_once(
    "lib/db/src/schema/cleanupQueue.ts",
    '''    // Human-readable description of what to fix.
    note: text("note").notNull(),
    status: cleanupQueueStatusEnum("status").notNull().default("open"),''',
    '''    // Human-readable shared working text. Team members may edit this note to
    // exchange updates about the cleanup item.
    note: text("note").notNull(),
    // User who first created the flag. Historical migration-seeded rows remain
    // null and are presented as System.
    flaggedByUserId: text("flagged_by_user_id"),
    status: cleanupQueueStatusEnum("status").notNull().default("open"),''',
    "cleanup queue schema provenance",
)

Path("lib/db/migrations/0220_cleanup_queue_collaboration.sql").write_text(
    '''-- Add user provenance to cleanup flags. Existing migration-seeded rows are
-- intentionally left NULL and render as System in the review queue.

ALTER TABLE cleanup_queue
  ADD COLUMN IF NOT EXISTS flagged_by_user_id text;

CREATE INDEX IF NOT EXISTS cleanup_queue_flagged_by_user_idx
  ON cleanup_queue(flagged_by_user_id);
''',
    encoding="utf-8",
)

# Contract-first API changes.
replace_once(
    "lib/api-spec/openapi.yaml",
    '''  /cleanup-queue/{id}/resolve:
    post:''',
    '''  /cleanup-queue/{id}:
    patch:
      operationId: updateCleanupItem
      tags: [cleanup-queue]
      summary: Update the cleanup item's shared working note. Any signed-in team member may edit it.
      parameters: [ { $ref: "#/components/parameters/IdPath" } ]
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: "#/components/schemas/UpdateCleanupItemBody" } } }
      responses:
        "200": { description: OK, content: { application/json: { schema: { $ref: "#/components/schemas/CleanupItem" } } } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "404": { $ref: "#/components/responses/NotFound" }
  /cleanup-queue/{id}/resolve:
    post:''',
    "cleanup update endpoint contract",
)
replace_once(
    "lib/api-spec/openapi.yaml",
    '''      required: [id, targetType, targetId, reasonCode, note, status, flaggedAt, createdAt, updatedAt]''',
    '''      required: [id, targetType, targetId, reasonCode, note, flaggedByUserId, flaggedByUserName, status, flaggedAt, createdAt, updatedAt]''',
    "cleanup item required provenance",
)
replace_once(
    "lib/api-spec/openapi.yaml",
    '''        note:             { type: string, description: "Human-readable description of what to fix." }
        status:           { $ref: "#/components/schemas/CleanupQueueStatus" }''',
    '''        note:             { type: string, description: "Shared working text describing the issue and team updates." }
        flaggedByUserId:  { type: string, nullable: true, description: "User who originally flagged the item; null for system-seeded historical rows." }
        flaggedByUserName: { type: string, nullable: true, description: "Display name of the user who originally flagged the item; null for system-seeded historical rows." }
        status:           { $ref: "#/components/schemas/CleanupQueueStatus" }''',
    "cleanup item provenance properties",
)
replace_once(
    "lib/api-spec/openapi.yaml",
    '''    CodingFormRowStatus:
      type: string''',
    '''    UpdateCleanupItemBody:
      type: object
      required: [note]
      properties:
        note: { type: string, minLength: 1, maxLength: 20000, description: "Replacement shared working text for this cleanup item." }
    CodingFormRowStatus:
      type: string''',
    "cleanup update body schema",
)

# API route.
replace_once(
    "artifacts/api-server/src/routes/cleanupQueue.ts",
    '''import { FlagForResearchBody, ListCleanupQueueQueryParams } from "@workspace/api-zod";''',
    '''import {
  FlagForResearchBody,
  ListCleanupQueueQueryParams,
  UpdateCleanupItemBody,
} from "@workspace/api-zod";''',
    "cleanup route contract imports",
)
replace_once(
    "artifacts/api-server/src/routes/cleanupQueue.ts",
    '''type CleanupRow = typeof cleanupQueue.$inferSelect & {
  targetName: string | null;
  resolvedByUserName: string | null;
};''',
    '''type CleanupRow = typeof cleanupQueue.$inferSelect & {
  targetName: string | null;
  flaggedByUserName: string | null;
  resolvedByUserName: string | null;
};''',
    "cleanup row response type",
)
replace_once(
    "artifacts/api-server/src/routes/cleanupQueue.ts",
    '''    note: row.note,
    status: row.status,''',
    '''    note: row.note,
    flaggedByUserId: row.flaggedByUserId ?? null,
    flaggedByUserName: row.flaggedByUserName ?? null,
    status: row.status,''',
    "cleanup serializer provenance",
)
replace_once(
    "artifacts/api-server/src/routes/cleanupQueue.ts",
    '''          note: cleanupQueue.note,
          status: cleanupQueue.status,''',
    '''          note: cleanupQueue.note,
          flaggedByUserId: cleanupQueue.flaggedByUserId,
          status: cleanupQueue.status,''',
    "cleanup list select provenance id",
)
replace_once(
    "artifacts/api-server/src/routes/cleanupQueue.ts",
    '''          )`,
          resolvedByUserName: userNameExpr,''',
    '''          )`,
          flaggedByUserName: sql<string | null>`(
            SELECT COALESCE(
              NULLIF(flagged_user.display_name, ''),
              NULLIF(TRIM(CONCAT_WS(' ', flagged_user.first_name, flagged_user.last_name)), ''),
              flagged_user.email
            )
            FROM users flagged_user
            WHERE flagged_user.id = ${cleanupQueue.flaggedByUserId}
            LIMIT 1
          )`,
          resolvedByUserName: userNameExpr,''',
    "cleanup list flagged user name",
)
replace_once(
    "artifacts/api-server/src/routes/cleanupQueue.ts",
    '''    const reasonCode = "needs_research";
    const note = body.note.trim();''',
    '''    const reasonCode = "needs_research";
    const actor = getAppUser(req);
    const note = body.note.trim();''',
    "cleanup flag actor",
)
replace_once(
    "artifacts/api-server/src/routes/cleanupQueue.ts",
    '''        reasonCode,
        note,
        status: "open",''',
    '''        reasonCode,
        note,
        flaggedByUserId: actor?.id ?? null,
        status: "open",''',
    "cleanup insert provenance",
)
replace_once(
    "artifacts/api-server/src/routes/cleanupQueue.ts",
    '''// Shared open → terminal transition. Guards status='open' in the UPDATE WHERE so''',
    '''// The note is intentionally editable in every status. Resolved and dismissed
// cards remain useful as a durable exchange between the person who flagged the
// issue and the person who investigated it.
router.patch(
  "/cleanup-queue/:id",
  asyncHandler(async (req, res) => {
    const id = paramId(req);
    const body = parseOrBadRequest(UpdateCleanupItemBody, req.body, res);
    if (!body) return;
    const note = body.note.trim();
    if (!note) {
      res.status(400).json({
        error: "bad_request",
        message: "A cleanup note is required.",
      });
      return;
    }

    const updated = await db
      .update(cleanupQueue)
      .set({ note, updatedAt: new Date() })
      .where(eq(cleanupQueue.id, id))
      .returning();
    if (!updated[0]) {
      notFound(res, "cleanup item");
      return;
    }
    const enriched = await enrich(updated);
    res.json(serialize(enriched[0]!));
  }),
);

// Shared open → terminal transition. Guards status='open' in the UPDATE WHERE so''',
    "cleanup note update route",
)
replace_once(
    "artifacts/api-server/src/routes/cleanupQueue.ts",
    '''  const userIds = [
    ...new Set(rows.map((r) => r.resolvedByUserId).filter(Boolean) as string[]),
  ];''',
    '''  const userIds = [
    ...new Set(
      rows
        .flatMap((r) => [r.flaggedByUserId, r.resolvedByUserId])
        .filter(Boolean) as string[],
    ),
  ];''',
    "cleanup enrichment user ids",
)
replace_once(
    "artifacts/api-server/src/routes/cleanupQueue.ts",
    '''    resolvedByUserName: r.resolvedByUserId
      ? (userMap.get(r.resolvedByUserId) ?? null)
      : null,''',
    '''    flaggedByUserName: r.flaggedByUserId
      ? (userMap.get(r.flaggedByUserId) ?? null)
      : null,
    resolvedByUserName: r.resolvedByUserId
      ? (userMap.get(r.resolvedByUserId) ?? null)
      : null,''',
    "cleanup enrichment provenance names",
)

# Replace the page with a compact collaborative editor.
Path("artifacts/wildflower-crm/src/pages/cleanup-queue.tsx").write_text(
    '''import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCleanupQueue,
  getListCleanupQueueQueryKey,
  useUpdateCleanupItem,
  useResolveCleanupItem,
  useDismissCleanupItem,
  type CleanupItem,
  type CleanupQueueStatus,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { formatDateShort } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const CLEANUP_KEY_PREFIX = "/api/cleanup-queue";

const STATUS_LABEL: Record<CleanupQueueStatus, string> = {
  open: "Open",
  resolved: "Resolved",
  dismissed: "Dismissed",
};

const REASON_LABEL: Record<string, string> = {
  conditional_commitment_stage: "Conditional commitment",
  needs_research: "Research needed",
  issues_to_address: "Issue to address",
};

function targetHref(type: string, id: string): string {
  switch (type) {
    case "pledge":
      return `/pledges/${id}`;
    case "opportunity":
      return `/opportunities/${id}`;
    case "organization":
      return `/organizations/${id}`;
    case "person":
      return `/individuals/${id}`;
    case "gift":
      return `/gifts/${id}`;
    case "staged_payment":
    case "stripe_payout":
      return "/reconciliation/deposits";
    default:
      return `/pledges/${id}`;
  }
}

export default function CleanupQueuePage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<CleanupQueueStatus>("open");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftNote, setDraftNote] = useState("");

  const params = { status, limit: 200 } as const;
  const { data, isLoading, isError } = useListCleanupQueue(params, {
    query: { queryKey: getListCleanupQueueQueryKey(params) },
  });

  const updateMut = useUpdateCleanupItem();
  const resolveMut = useResolveCleanupItem();
  const dismissMut = useDismissCleanupItem();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: [CLEANUP_KEY_PREFIX] });

  const startEditing = (item: CleanupItem) => {
    setEditingId(item.id);
    setDraftNote(item.note);
  };

  const cancelEditing = () => {
    setEditingId(null);
    setDraftNote("");
  };

  const handleSaveNote = (item: CleanupItem) => {
    const note = draftNote.trim();
    if (!note) {
      toast({
        title: "A note is required",
        description: "Cleanup records cannot have an empty note.",
        variant: "destructive",
      });
      return;
    }
    updateMut.mutate(
      { id: item.id, data: { note } },
      {
        onSuccess: () => {
          cancelEditing();
          void invalidate();
          toast({ title: "Cleanup note saved" });
        },
        onError: (err) =>
          toast({
            title: "Couldn't save note",
            description:
              err instanceof Error ? err.message : "Something went wrong.",
            variant: "destructive",
          }),
      },
    );
  };

  const handleResolve = (item: CleanupItem) => {
    resolveMut.mutate(
      { id: item.id },
      {
        onSuccess: () => {
          void invalidate();
          toast({
            title: "Resolved",
            description: "This item has been cleared from the queue.",
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't resolve",
            description:
              err instanceof Error ? err.message : "Something went wrong.",
            variant: "destructive",
          }),
      },
    );
  };

  const handleDismiss = (item: CleanupItem) => {
    dismissMut.mutate(
      { id: item.id },
      {
        onSuccess: () => {
          void invalidate();
          toast({
            title: "Dismissed",
            description: "This item won't show in the open queue.",
          });
        },
        onError: (err) =>
          toast({
            title: "Couldn't dismiss",
            description:
              err instanceof Error ? err.message : "Something went wrong.",
            variant: "destructive",
          }),
      },
    );
  };

  const items = data?.data ?? [];
  const pending =
    updateMut.isPending || resolveMut.isPending || dismissMut.isPending;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Cleanup Queue
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Records flagged for manual data cleanup. Edit the shared note to exchange
          updates with other reviewers, then resolve the item — or dismiss it if no
          change is needed.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={status}
          onValueChange={(v) => setStatus(v as CleanupQueueStatus)}
        >
          <SelectTrigger className="w-48" data-testid="select-cleanup-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open</SelectItem>
            <SelectItem value="resolved">Resolved</SelectItem>
            <SelectItem value="dismissed">Dismissed</SelectItem>
          </SelectContent>
        </Select>
        {!isLoading && !isError ? (
          <span className="ml-auto text-sm text-muted-foreground">
            {items.length.toLocaleString()} {items.length === 1 ? "item" : "items"}
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Loading cleanup queue…
        </p>
      ) : isError ? (
        <p className="text-sm text-destructive py-8 text-center">
          Failed to load the cleanup queue.
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          {status === "open"
            ? "Nothing to clean up. 🎉"
            : `No ${STATUS_LABEL[status].toLowerCase()} items.`}
        </p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const editing = editingId === item.id;
            return (
              <div
                key={item.id}
                className="rounded-lg border p-4 space-y-2"
                data-testid={`cleanup-item-${item.id}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">
                    {REASON_LABEL[item.reasonCode] ?? item.reasonCode}
                  </Badge>
                  {item.status !== "open" ? (
                    <Badge variant="outline">{STATUS_LABEL[item.status]}</Badge>
                  ) : null}
                  <span className="ml-auto text-xs text-muted-foreground">
                    Flagged {formatDateShort(item.flaggedAt)} by{" "}
                    {item.flaggedByUserName ?? "System"}
                  </span>
                </div>

                <Link
                  href={targetHref(item.targetType, item.targetId)}
                  className="font-medium text-primary underline-offset-2 hover:underline break-words"
                  data-testid={`link-cleanup-target-${item.id}`}
                >
                  {item.targetName ?? `${item.targetType} ${item.targetId}`}
                </Link>

                {editing ? (
                  <div className="space-y-2">
                    <Textarea
                      value={draftNote}
                      onChange={(event) => setDraftNote(event.target.value)}
                      rows={5}
                      disabled={updateMut.isPending}
                      data-testid={`textarea-cleanup-note-${item.id}`}
                    />
                    <div className="flex justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={updateMut.isPending}
                        onClick={cancelEditing}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        disabled={updateMut.isPending || !draftNote.trim()}
                        onClick={() => handleSaveNote(item)}
                        data-testid={`button-save-note-${item.id}`}
                      >
                        Save note
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {item.note}
                  </p>
                )}

                {!editing ? (
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={pending}
                      onClick={() => startEditing(item)}
                      data-testid={`button-edit-note-${item.id}`}
                    >
                      Edit note
                    </Button>
                    {item.status === "open" ? (
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={pending}
                          onClick={() => handleDismiss(item)}
                          data-testid={`button-dismiss-${item.id}`}
                        >
                          Dismiss
                        </Button>
                        <Button
                          size="sm"
                          disabled={pending}
                          onClick={() => handleResolve(item)}
                          data-testid={`button-resolve-${item.id}`}
                        >
                          Resolve
                        </Button>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {STATUS_LABEL[item.status]}
                        {item.resolvedByUserName
                          ? ` by ${item.resolvedByUserName}`
                          : ""}
                        {item.resolvedAt
                          ? ` on ${formatDateShort(item.resolvedAt)}`
                          : ""}
                      </p>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
''',
    encoding="utf-8",
)

# Extend the existing integration suite with provenance and note editing.
test_path = Path("artifacts/api-server/src/__tests__/flag-for-research.integration.test.ts")
test = test_path.read_text(encoding="utf-8")
test = test.replace(
    '''  status: string;
};''',
    '''  status: string;
  flaggedByUserId: string | null;
  flaggedByUserName: string | null;
};''',
    1,
)
test = test.replace(
    '''    email: `${USER_ID}@wildflowerschools.org`,
    role: "team_member",''',
    '''    email: `${USER_ID}@wildflowerschools.org`,
    displayName: "Cleanup Queue Reporter",
    role: "team_member",''',
    1,
)
test = test.replace(
    '''    expect(json.reasonCode).toBe("needs_research");
    expect(json.status).toBe("open");''',
    '''    expect(json.reasonCode).toBe("needs_research");
    expect(json.flaggedByUserId).toBe(USER_ID);
    expect(json.flaggedByUserName).toBe("Cleanup Queue Reporter");
    expect(json.status).toBe("open");''',
    1,
)
test = test.replace(
    '''  it("rejects a blank note (400)", async () => {''',
    '''  it("updates the shared cleanup note", async () => {
    const res = await fetch(`${baseUrl}/api/cleanup-queue/${CLEANUP_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        note: "Original issue.\\n\\nCleanup Queue Reporter: I checked the source file and still need a second review.",
      }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as CleanupItem;
    expect(json.note).toContain("still need a second review");
    expect(json.flaggedByUserName).toBe("Cleanup Queue Reporter");

    const stored = await db
      .select({ note: schema.cleanupQueue.note })
      .from(schema.cleanupQueue)
      .where(eqFn(schema.cleanupQueue.id, CLEANUP_ID));
    expect(stored[0]?.note).toBe(json.note);
  });

  it("rejects an empty replacement note", async () => {
    const res = await fetch(`${baseUrl}/api/cleanup-queue/${CLEANUP_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a blank note (400)", async () => {''',
    1,
)
test_path.write_text(test, encoding="utf-8")

print("cleanup queue collaboration patch applied")
