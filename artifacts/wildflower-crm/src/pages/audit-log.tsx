import { useState } from "react";
import {
  useListAuditLog,
  getListAuditLogQueryKey,
  type AuditLogEntry,
  type AuditChange,
} from "@workspace/api-client-react";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const PAGE_SIZE = 50;

const ACTIONS = [
  "create",
  "update",
  "archive",
  "unarchive",
  "delete",
  "merge",
  "bulk_update",
  "bulk_archive",
] as const;

const ENTITY_TYPES = [
  "person",
  "organization",
  "household",
  "opportunity",
  "gift",
] as const;

const ACTION_LABEL: Record<string, string> = {
  create: "Created",
  update: "Updated",
  archive: "Archived",
  unarchive: "Unarchived",
  delete: "Deleted",
  merge: "Merged",
  bulk_update: "Bulk update",
  bulk_archive: "Bulk archive",
};

// Color the action chip so destructive/structural events stand out from the
// routine create/update stream.
const ACTION_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  create: "secondary",
  update: "outline",
  archive: "destructive",
  unarchive: "secondary",
  delete: "destructive",
  merge: "default",
  bulk_update: "outline",
  bulk_archive: "destructive",
};

const ENTITY_LABEL: Record<string, string> = {
  person: "Person",
  organization: "Organization",
  household: "Household",
  opportunity: "Opportunity",
  gift: "Gift",
};

// The whole app reasons in America/Chicago; audit timestamps should too.
const dateTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function formatWhen(iso: string): string {
  try {
    return dateTimeFmt.format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v === "" ? "(empty)" : v;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function ChangeList({ changes }: { changes: AuditChange[] }) {
  if (!changes.length) return <span className="text-muted-foreground">—</span>;
  return (
    <ul className="space-y-0.5">
      {changes.map((c, i) => (
        <li key={`${c.field}-${i}`} className="text-xs">
          <span className="font-medium">{c.field}</span>:{" "}
          <span className="text-muted-foreground line-through">{formatValue(c.from)}</span>
          {" → "}
          <span>{formatValue(c.to)}</span>
        </li>
      ))}
    </ul>
  );
}

function entityHref(entry: AuditLogEntry): string | null {
  switch (entry.entityType) {
    case "person":
      return `/individuals/${entry.entityId}`;
    case "organization":
      return `/organizations/${entry.entityId}`;
    case "household":
      return `/households/${entry.entityId}`;
    case "opportunity":
      return `/opportunities/${entry.entityId}`;
    case "gift":
      return `/gifts/${entry.entityId}`;
    default:
      return null;
  }
}

export default function AuditLogPage() {
  const isAdmin = useIsAdmin();
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<string>("all");
  const [entityType, setEntityType] = useState<string>("all");

  const params = {
    page,
    limit: PAGE_SIZE,
    ...(action !== "all" ? { action } : {}),
    ...(entityType !== "all" ? { entityType } : {}),
  };
  const { data, isLoading, isError } = useListAuditLog(params, {
    query: { enabled: isAdmin, queryKey: getListAuditLogQueryKey(params) },
  });

  if (!isAdmin) {
    return (
      <div className="max-w-3xl">
        <h1 className="text-3xl font-serif font-bold text-foreground">Audit Log</h1>
        <p className="mt-4 text-sm text-muted-foreground">
          The audit log is only available to administrators.
        </p>
      </div>
    );
  }

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const resetTo = (setter: (v: string) => void) => (v: string) => {
    setter(v);
    setPage(1);
  };

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">Audit Log</h1>
        <p className="text-sm text-muted-foreground mt-1">
          A chronological record of who changed what across the CRM — creates,
          edits, archives, merges, and bulk actions.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={action} onValueChange={resetTo(setAction)}>
          <SelectTrigger className="w-44" data-testid="select-audit-action">
            <SelectValue placeholder="All actions" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {ACTIONS.map((a) => (
              <SelectItem key={a} value={a}>
                {ACTION_LABEL[a]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={entityType} onValueChange={resetTo(setEntityType)}>
          <SelectTrigger className="w-44" data-testid="select-audit-entity-type">
            <SelectValue placeholder="All record types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All record types</SelectItem>
            {ENTITY_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {ENTITY_LABEL[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="ml-auto text-sm text-muted-foreground">
          {total.toLocaleString()} {total === 1 ? "entry" : "entries"}
        </span>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-44">When</TableHead>
              <TableHead className="w-48">Actor</TableHead>
              <TableHead className="w-32">Action</TableHead>
              <TableHead className="w-40">Record</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                  Loading…
                </TableCell>
              </TableRow>
            ) : isError ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-destructive py-8">
                  Failed to load the audit log.
                </TableCell>
              </TableRow>
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-sm text-muted-foreground py-8">
                  No audit entries match these filters.
                </TableCell>
              </TableRow>
            ) : (
              rows.map((entry) => {
                const href = entityHref(entry);
                return (
                  <TableRow key={entry.id} data-testid={`row-audit-${entry.id}`}>
                    <TableCell className="text-sm whitespace-nowrap">
                      {formatWhen(entry.createdAt)}
                    </TableCell>
                    <TableCell className="text-sm">
                      <div className="font-medium">{entry.actorName ?? "Unknown"}</div>
                      {entry.actorEmail ? (
                        <div className="text-xs text-muted-foreground">{entry.actorEmail}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Badge variant={ACTION_VARIANT[entry.action] ?? "outline"}>
                        {ACTION_LABEL[entry.action] ?? entry.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      <div className="capitalize">
                        {ENTITY_LABEL[entry.entityType] ?? entry.entityType}
                      </div>
                      {href ? (
                        <a
                          href={href}
                          className="text-xs text-primary underline break-all"
                        >
                          {entry.entityId}
                        </a>
                      ) : (
                        <div className="text-xs text-muted-foreground break-all">
                          {entry.entityId}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {entry.summary ? (
                        <div className="mb-1">{entry.summary}</div>
                      ) : null}
                      {entry.changes && entry.changes.length > 0 ? (
                        <ChangeList changes={entry.changes} />
                      ) : !entry.summary ? (
                        <span className="text-muted-foreground">—</span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          Page {page} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            data-testid="button-audit-prev"
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            data-testid="button-audit-next"
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
