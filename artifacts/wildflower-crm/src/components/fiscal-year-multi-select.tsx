import { useMemo, useState } from "react";
import { useListFiscalYears } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { ChevronDown } from "lucide-react";
import { BLANK_VALUE, BLANK_LABEL } from "@/components/multi-filter-select";

// Multi-select dropdown for the `fiscalYear` filter. Options are pulled
// from the fiscal-years table (slugs like `fy2026`). Sorted newest →
// oldest, clipped to 2016..currentFY+3. The legacy `future` sentinel is
// excluded from this picker.
export function FiscalYearMultiSelect({
  selected,
  onChange,
  testId = "select-fiscal-year",
  includeBlank = true,
}: {
  selected: string[];
  onChange: (v: string[]) => void;
  testId?: string;
  /**
   * When true (default) prepends a "(Blank)" option that matches
   * opps/gifts with no allocation rows at all.
   */
  includeBlank?: boolean;
}) {
  const { data: allFys } = useListFiscalYears();
  const [open, setOpen] = useState(false);

  const options = useMemo(() => {
    const rows = allFys ?? [];
    const currentYear = new Date().getUTCFullYear();
    const currentFyEnd =
      new Date().getUTCMonth() >= 6 ? currentYear + 1 : currentYear;
    const visible = rows.filter((r) => {
      const m = /^fy(\d{4})$/.exec(r.id);
      if (!m) return false;
      const yr = Number(m[1]);
      return yr >= 2016 && yr <= currentFyEnd + 3;
    });
    visible.sort((a, b) => b.id.localeCompare(a.id));
    return visible;
  }, [allFys]);

  const toggle = (id: string) => {
    if (selected.includes(id)) onChange(selected.filter((x) => x !== id));
    else onChange([...selected, id]);
  };

  const labelFor = (id: string): string => {
    if (id === BLANK_VALUE) return BLANK_LABEL;
    return allFys?.find((r) => r.id === id)?.label ?? id;
  };
  const label =
    selected.length === 0
      ? "Any"
      : selected.length === 1
        ? labelFor(selected[0]!)
        : `${selected.length} selected`;

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">
        Fiscal year
      </label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-label="Fiscal year"
            className="w-[200px] justify-between font-normal"
            data-testid={testId}
          >
            <span className="truncate">{label}</span>
            <ChevronDown className="h-4 w-4 opacity-50 shrink-0 ml-2" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[220px] p-2" align="start">
          <div className="max-h-[300px] overflow-y-auto space-y-1">
            {includeBlank && (
              <label
                key={BLANK_VALUE}
                className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer text-sm"
                data-testid={`option-fy-${BLANK_VALUE}`}
              >
                <Checkbox
                  checked={selected.includes(BLANK_VALUE)}
                  onCheckedChange={() => toggle(BLANK_VALUE)}
                />
                <span>{BLANK_LABEL}</span>
              </label>
            )}
            {options.length === 0 ? (
              <div className="text-sm text-muted-foreground px-2 py-1">
                Loading…
              </div>
            ) : (
              options.map((opt) => {
                const checked = selected.includes(opt.id);
                return (
                  <label
                    key={opt.id}
                    className="flex items-center gap-2 px-2 py-1 rounded hover:bg-muted cursor-pointer text-sm"
                    data-testid={`option-fy-${opt.id}`}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggle(opt.id)}
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
