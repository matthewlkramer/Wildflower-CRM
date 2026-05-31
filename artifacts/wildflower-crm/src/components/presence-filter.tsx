import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

/**
 * The only two non-empty states a presence filter can hold. `undefined`
 * means "no constraint" (the param is omitted from the request).
 */
export type PresenceValue = "has" | "blank" | undefined;

type Props = {
  label: string;
  value: PresenceValue;
  onChange: (next: PresenceValue) => void;
  testId: string;
  width?: string;
  /** Label for the `has` option. Defaults to "Has value". */
  hasLabel?: string;
  /** Label for the `blank` option. Defaults to "Blank". */
  blankLabel?: string;
};

/**
 * Presence filter for computed / rollup columns that have no enum to
 * multi-select on. Lets the user narrow to rows that *have* a value
 * versus rows where the value is *blank* (null / empty / zero). Renders
 * like `MultiFilterSelect` (labeled popover trigger) for visual
 * consistency, but is a single tri-state choice rather than a checkbox
 * set: Any / Has value / Blank.
 */
export function PresenceFilter({
  label,
  value,
  onChange,
  testId,
  width = "w-[160px]",
  hasLabel = "Has value",
  blankLabel = "Blank",
}: Props) {
  const [open, setOpen] = useState(false);
  const options: { value: PresenceValue; label: string }[] = [
    { value: undefined, label: "Any" },
    { value: "has", label: hasLabel },
    { value: "blank", label: blankLabel },
  ];
  const triggerLabel =
    value === "has" ? hasLabel : value === "blank" ? blankLabel : "Any";

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-label={label}
            className={`${width} justify-between font-normal`}
            data-testid={testId}
          >
            <span className="truncate">{triggerLabel}</span>
            <ChevronDown className="h-4 w-4 opacity-50 shrink-0 ml-2" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[200px] p-1" align="start">
          <div className="space-y-0.5">
            {options.map((opt) => {
              const active = value === opt.value;
              return (
                <button
                  key={opt.label}
                  type="button"
                  className={
                    "w-full text-left px-2 py-1.5 rounded text-sm hover:bg-muted " +
                    (active ? "bg-muted font-medium" : "")
                  }
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                  data-testid={`option-${testId}-${opt.value ?? "any"}`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
