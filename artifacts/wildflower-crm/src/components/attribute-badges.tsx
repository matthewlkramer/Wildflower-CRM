import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  InlineEditSelect,
  type InlineSelectOption,
} from "@/components/inline-edit";

/**
 * Compact chip strip for secondary relationship attributes (connection,
 * enthusiasm, status, alignment). Each chip is a full InlineEditSelect —
 * clicking the pencil opens the same select editor used everywhere else —
 * so the graduation from the record-v2 mockup keeps every field editable.
 */
export function AttributeBadges({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {children}
    </div>
  );
}

export function AttributeBadgeSelect<T extends string>({
  label,
  chipLabel,
  testIdBase,
  value,
  options,
  onSave,
  getVariant,
}: {
  /** Full field label used by the select editor and the hover tooltip. */
  label: string;
  /** Short label rendered inside the chip; defaults to `label`. */
  chipLabel?: string;
  testIdBase: string;
  value: T | null;
  options: ReadonlyArray<InlineSelectOption<T>>;
  onSave: (next: T | null) => void | Promise<unknown>;
  /** Optional per-value badge variant (defaults to "secondary" when set). */
  getVariant?: (value: T) => "default" | "secondary" | "outline";
}) {
  const current = value != null ? (options.find((o) => o.value === value) ?? null) : null;
  const short = chipLabel ?? label;
  return (
    <InlineEditSelect
      label={label}
      testIdBase={testIdBase}
      value={value}
      options={options}
      align="left"
      display={
        current ? (
          <Badge
            variant={getVariant ? getVariant(current.value) : "secondary"}
            title={`${label}: ${current.label}`}
            className="max-w-full"
          >
            <span className="mr-1 font-normal opacity-70">{short}</span>
            <span className="truncate">{current.label}</span>
          </Badge>
        ) : (
          <Badge
            variant="outline"
            title={`${label}: not set`}
            className="max-w-full font-normal text-muted-foreground"
          >
            <span className="mr-1 opacity-70">{short}</span>—
          </Badge>
        )
      }
      onSave={onSave}
    />
  );
}
