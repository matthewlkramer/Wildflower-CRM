import { Star } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useUpdateFunder,
  useUpdatePerson,
  getListFundersQueryKey,
  getListPeopleQueryKey,
  getGetFunderQueryKey,
  getGetPersonQueryKey,
} from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

type Kind = "funder" | "person";

type Props = {
  kind: Kind;
  id: string;
  isPriority: boolean | null | undefined;
  /** Read-only star (no toggle). Used when displayed inline next to a donor name. */
  readOnly?: boolean;
  /** Visual size — `sm` for inline next to a name, `md` for table cells. */
  size?: "sm" | "md";
  className?: string;
};

/**
 * Renders a star icon for the "top priority" flag on funders and
 * people. In the default interactive mode, clicking the star toggles
 * the flag via PATCH and invalidates the relevant list + detail
 * queries so the UI updates without a full refetch dance. In
 * `readOnly` mode it's a pure indicator (used inline next to donor
 * names on opportunities / gifts rows).
 */
export function PriorityStar({ kind, id, isPriority, readOnly, size = "md", className }: Props) {
  const qc = useQueryClient();
  const updateFunder = useUpdateFunder();
  const updatePerson = useUpdatePerson();
  const filled = Boolean(isPriority);

  const dimensions = size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4";
  const star = (
    <Star
      className={cn(
        dimensions,
        filled
          ? "fill-amber-400 text-amber-500"
          : "text-muted-foreground/40",
        className,
      )}
    />
  );

  if (readOnly) {
    if (!filled) return null;
    return (
      <span
        aria-label="Top priority"
        title="Top priority"
        className="inline-flex shrink-0 align-middle"
      >
        {star}
      </span>
    );
  }

  const pending = updateFunder.isPending || updatePerson.isPending;
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (pending) return;
    const next = !filled;
    const opts = {
      onSuccess: () => {
        if (kind === "funder") {
          qc.invalidateQueries({ queryKey: getListFundersQueryKey() });
          qc.invalidateQueries({ queryKey: getGetFunderQueryKey(id) });
        } else {
          qc.invalidateQueries({ queryKey: getListPeopleQueryKey() });
          qc.invalidateQueries({ queryKey: getGetPersonQueryKey(id) });
        }
      },
    };
    if (kind === "funder") {
      updateFunder.mutate({ id, data: { isPriority: next } }, opts);
    } else {
      updatePerson.mutate({ id, data: { isPriority: next } }, opts);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-pressed={filled}
      aria-label={filled ? "Unmark top priority" : "Mark top priority"}
      title={filled ? "Top priority — click to unmark" : "Mark as top priority"}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded p-0.5 transition-colors",
        "hover:bg-muted disabled:opacity-50",
      )}
      data-testid={`priority-star-${kind}-${id}`}
    >
      {star}
    </button>
  );
}
