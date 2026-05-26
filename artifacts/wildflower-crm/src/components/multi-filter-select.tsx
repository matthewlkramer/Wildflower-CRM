import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { formatEnum } from "@/lib/format";

export type MultiFilterOption = {
  value: string;
  label: string;
};

type Props = {
  label: string;
  selected: string[];
  onChange: (next: string[]) => void;
  /** Either a list of slugs (auto-labeled via `formatEnum`) or full {value,label} pairs. */
  options: readonly string[] | readonly MultiFilterOption[];
  testId: string;
  width?: string;
};

/**
 * Generic multi-select filter dropdown used by all list pages. Renders
 * as a popover with checkboxes; trigger shows "Any" / single label /
 * "N selected". Selection order is meaningful only to the caller —
 * pages should sort the array before serializing into request params
 * so the react-query cache key is stable regardless of click order.
 */
export function MultiFilterSelect({
  label,
  selected,
  onChange,
  options,
  testId,
  width = "w-[200px]",
}: Props) {
  const [open, setOpen] = useState(false);
  const normalized: MultiFilterOption[] =
    typeof options[0] === "string" || options.length === 0
      ? (options as readonly string[]).map((v) => ({
          value: v,
          label: formatEnum(v) ?? v,
        }))
      : (options as readonly MultiFilterOption[]).slice();

  const toggle = (v: string) => {
    if (selected.includes(v)) onChange(selected.filter((x) => x !== v));
    else onChange([...selected, v]);
  };

  const triggerLabel =
    selected.length === 0
      ? "Any"
      : selected.length === 1
        ? (normalized.find((o) => o.value === selected[0])?.label ??
          selected[0])
        : `${selected.length} selected`;

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
        <PopoverContent className="w-[240px] p-2" align="start">
          <div className="max-h-[300px] overflow-y-auto space-y-1">
            {normalized.length === 0 ? (
              <div className="text-sm text-muted-foreground px-2 py-1">
                No options
              </div>
            ) : (
              normalized.map((opt) => {
                const checked = selected.includes(opt.value);
                return (
                  <label
                    key={opt.value}
                    className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer text-sm"
                    data-testid={`option-${testId}-${opt.value}`}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggle(opt.value)}
                    />
                    <span>{opt.label}</span>
                  </label>
                );
              })
            )}
          </div>
          {selected.length > 0 && (
            <div className="mt-2 pt-2 border-t">
              <Button
                variant="ghost"
                size="sm"
                className="w-full h-7 text-xs"
                onClick={() => onChange([])}
                data-testid={`${testId}-clear`}
              >
                Clear
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}
