import { useEffect, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, Eraser } from "lucide-react";
import {
  useListRestrictionTextReview,
  getListRestrictionTextReviewQueryKey,
  useUpdateGiftAllocation,
  useUpdatePledgeAllocation,
  type RestrictionTextReviewRow,
  type ListRestrictionTextReviewParams,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency } from "@/lib/format";
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

const REVIEW_KEY_PREFIX = "/api/restriction-text-review";

type SourceFilter = "all" | "gift" | "pledge";

function parentHref(row: RestrictionTextReviewRow): string {
  return row.source === "gift" ? `/gifts/${row.parentId}` : `/pledges/${row.parentId}`;
}

// One review card: the remaining verbatim text plus an editable description,
// saved through the existing allocation PATCH endpoints (the single write
// path). "Move to description" is the common fix — the automated sort left
// text in purpose_verbatim that is really a plain-language description.
function ReviewRow({ row }: { row: RestrictionTextReviewRow }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [verbatim, setVerbatim] = useState(row.purposeVerbatim);
  const [description, setDescription] = useState(row.restrictionDescription ?? "");

  // Reset local drafts when the server row changes (e.g. after refetch).
  useEffect(() => {
    setVerbatim(row.purposeVerbatim);
    setDescription(row.restrictionDescription ?? "");
  }, [row.purposeVerbatim, row.restrictionDescription]);

  const giftMut = useUpdateGiftAllocation();
  const pledgeMut = useUpdatePledgeAllocation();
  const pending = giftMut.isPending || pledgeMut.isPending;

  const save = (nextVerbatim: string, nextDescription: string) => {
    const body = {
      purposeVerbatim: nextVerbatim.trim() === "" ? null : nextVerbatim,
      restrictionDescription: nextDescription.trim() === "" ? null : nextDescription,
    };
    const onSuccess = () => {
      void queryClient.invalidateQueries({ queryKey: [REVIEW_KEY_PREFIX] });
      toast({
        title: "Saved",
        description:
          body.purposeVerbatim === null
            ? "Verbatim text cleared — this allocation drops off the review list."
            : "Allocation updated.",
      });
    };
    const onError = (err: unknown) =>
      toast({
        title: "Couldn't save",
        description: err instanceof Error ? err.message : "Something went wrong.",
        variant: "destructive",
      });
    if (row.source === "gift") {
      giftMut.mutate({ id: row.allocationId, data: body }, { onSuccess, onError });
    } else {
      pledgeMut.mutate({ id: row.allocationId, data: body }, { onSuccess, onError });
    }
  };

  const dirty =
    verbatim !== row.purposeVerbatim ||
    description !== (row.restrictionDescription ?? "");

  return (
    <div
      className="rounded-lg border p-4 space-y-3"
      data-testid={`review-row-${row.allocationId}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">
          {row.source === "gift" ? "Gift allocation" : "Pledge allocation"}
        </Badge>
        <Link
          href={parentHref(row)}
          className="font-medium text-primary underline-offset-2 hover:underline break-words"
          data-testid={`link-review-parent-${row.allocationId}`}
        >
          {row.parentName ?? (row.source === "gift" ? "Unnamed gift" : "Unnamed pledge")}
        </Link>
        {row.donorName ? (
          <span className="text-sm text-muted-foreground">— {row.donorName}</span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {row.subAmount ? formatCurrency(row.subAmount) : null}
          {row.subAmount && row.grantYear ? " · " : ""}
          {row.grantYear ?? ""}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label
            className="text-xs font-medium text-muted-foreground"
            htmlFor={`verbatim-${row.allocationId}`}
          >
            Restriction language (verbatim)
          </label>
          <Textarea
            id={`verbatim-${row.allocationId}`}
            className="text-sm min-h-[72px]"
            value={verbatim}
            onChange={(e) => setVerbatim(e.target.value)}
            placeholder="Exact source language only (grant letter, designation, memo)"
            data-testid={`input-verbatim-${row.allocationId}`}
          />
        </div>
        <div className="space-y-1">
          <label
            className="text-xs font-medium text-muted-foreground"
            htmlFor={`description-${row.allocationId}`}
          >
            Restriction description
          </label>
          <Textarea
            id={`description-${row.allocationId}`}
            className="text-sm min-h-[72px]"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Plain-language summary of the restriction"
            data-testid={`input-description-${row.allocationId}`}
          />
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={pending || verbatim.trim() === ""}
          onClick={() => {
            // Common fix: the text is really a description. Move it over
            // (append when a description already exists) and clear verbatim.
            const moved =
              description.trim() === ""
                ? verbatim.trim()
                : `${description.trim()}\n${verbatim.trim()}`;
            save("", moved);
          }}
          data-testid={`button-move-${row.allocationId}`}
        >
          <ArrowDownToLine className="h-4 w-4 mr-1" />
          Move to description
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={pending || verbatim.trim() === ""}
          onClick={() => save("", description)}
          data-testid={`button-clear-${row.allocationId}`}
        >
          <Eraser className="h-4 w-4 mr-1" />
          Clear verbatim
        </Button>
        <Button
          size="sm"
          disabled={pending || !dirty}
          onClick={() => save(verbatim, description)}
          data-testid={`button-save-${row.allocationId}`}
        >
          Save
        </Button>
      </div>
    </div>
  );
}

export default function RestrictionTextReviewPage() {
  const [source, setSource] = useState<SourceFilter>("all");

  const params: ListRestrictionTextReviewParams = {
    ...(source !== "all" ? { source } : {}),
    limit: 200,
  };
  const { data, isLoading, isError } = useListRestrictionTextReview(params, {
    query: { queryKey: getListRestrictionTextReviewQueryKey(params) },
  });

  const rows = data?.data ?? [];
  const total = data?.pagination.total ?? 0;

  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Restriction Text Review
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Allocations that still carry verbatim restriction text after the
          automated cleanup. Verbatim should hold exact source language only
          (grant letter, Donorbox designation, check memo) — if the text is
          really a plain-language summary, move it to the description. Clearing
          the verbatim field removes the allocation from this list.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={source} onValueChange={(v) => setSource(v as SourceFilter)}>
          <SelectTrigger className="w-56" data-testid="select-review-source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All allocations</SelectItem>
            <SelectItem value="gift">Gift allocations</SelectItem>
            <SelectItem value="pledge">Pledge allocations</SelectItem>
          </SelectContent>
        </Select>
        {!isLoading && !isError ? (
          <span className="ml-auto text-sm text-muted-foreground">
            {total.toLocaleString()} {total === 1 ? "allocation" : "allocations"} to review
            {total > rows.length ? ` (showing first ${rows.length})` : ""}
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Loading allocations…
        </p>
      ) : isError ? (
        <p className="text-sm text-destructive py-8 text-center">
          Failed to load the review list. This page is admin-only.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8 text-center">
          Nothing left to review. 🎉
        </p>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <ReviewRow key={`${row.source}-${row.allocationId}`} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}
