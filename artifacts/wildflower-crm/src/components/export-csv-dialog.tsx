import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import { downloadCsvExport } from "@/lib/csv-export";

interface Props {
  /** API path segment, e.g. "people" or "gifts-and-payments". */
  entityPath: string;
  /** Current list params (filters, search, saved-view state, worklist…). */
  filteredParams: Record<string, unknown>;
  /**
   * Params to keep for the "All rows" scope — baseline view scope only
   * (e.g. pledgeView, includeArchived), with user-selected filters removed.
   */
  allRowsParams: Record<string, unknown>;
  /** Column keys currently visible in the table (for "Visible fields"). */
  visibleFieldKeys: string[];
  /** Filename fallback + dialog copy, e.g. "individuals". */
  entityLabel: string;
}

/**
 * Shared "Export CSV" control for the five CRM list views. Opens a small
 * chooser (visible vs all fields; current filtered rows vs all rows), then
 * downloads a server-generated CSV that honors the exact list filters,
 * permissions, archive rules, and anonymous masking.
 */
export function ExportCsvDialog({
  entityPath,
  filteredParams,
  allRowsParams,
  visibleFieldKeys,
  entityLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [fieldMode, setFieldMode] = useState<"visible" | "all">("visible");
  const [rowMode, setRowMode] = useState<"filtered" | "all">("filtered");
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const onExport = async () => {
    setBusy(true);
    try {
      await downloadCsvExport(
        entityPath,
        rowMode === "filtered" ? filteredParams : allRowsParams,
        fieldMode === "visible" ? visibleFieldKeys : undefined,
        `${entityLabel}.csv`,
      );
      setOpen(false);
    } catch {
      toast({
        title: "Export failed",
        description: "The CSV could not be generated. Please try again.",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-export-csv">
          <Download className="h-4 w-4 mr-1" />
          Export CSV
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Export {entityLabel} to CSV</DialogTitle>
          <DialogDescription>
            The download is generated on the server and includes every
            matching row — not just the rows loaded on this page.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium mb-2">Fields</p>
            <RadioGroup
              value={fieldMode}
              onValueChange={(v) => setFieldMode(v as "visible" | "all")}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="visible" id="export-fields-visible" />
                <Label htmlFor="export-fields-visible" className="font-normal">
                  Visible fields (current columns)
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="all" id="export-fields-all" />
                <Label htmlFor="export-fields-all" className="font-normal">
                  All fields
                </Label>
              </div>
            </RadioGroup>
          </div>
          <div>
            <p className="text-sm font-medium mb-2">Rows</p>
            <RadioGroup
              value={rowMode}
              onValueChange={(v) => setRowMode(v as "filtered" | "all")}
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="filtered" id="export-rows-filtered" />
                <Label htmlFor="export-rows-filtered" className="font-normal">
                  Current filtered rows
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="all" id="export-rows-all" />
                <Label htmlFor="export-rows-all" className="font-normal">
                  All rows (clears filters)
                </Label>
              </div>
            </RadioGroup>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button onClick={onExport} disabled={busy} data-testid="button-export-csv-confirm">
            {busy ? "Exporting…" : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
