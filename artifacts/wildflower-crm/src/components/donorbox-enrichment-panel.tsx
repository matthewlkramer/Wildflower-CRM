import { Badge } from "@/components/ui/badge";
import { type DonorboxEnrichment } from "@workspace/api-client-react";

/**
 * Read-only Donorbox enrichment panel — surfaces the campaign / designation /
 * comment / recurring / donor facts joined from the Donorbox donation behind a
 * Stripe charge or gift. Enrichment only; never affects the money. Shared by the
 * Stripe reconciliation card and the gift-detail page.
 */
export function DonorboxEnrichmentPanel({
  donorbox,
  className,
}: {
  donorbox: DonorboxEnrichment;
  className?: string;
}) {
  return (
    <div
      className={`mt-3 space-y-1 rounded border border-sky-200 bg-sky-50 p-3 text-xs dark:border-sky-900/60 dark:bg-sky-950/30 ${className ?? ""}`}
      data-testid={`donorbox-enrichment-${donorbox.id}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className="border-sky-300 text-sky-700 dark:border-sky-800 dark:text-sky-300"
        >
          Donorbox
        </Badge>
        {donorbox.recurring && <Badge variant="outline">Recurring</Badge>}
        {donorbox.refunded && (
          <Badge variant="outline">Refunded in Donorbox</Badge>
        )}
        {donorbox.anonymous && <Badge variant="outline">Anonymous</Badge>}
      </div>
      {donorbox.campaignName && (
        <p className="text-muted-foreground">
          Campaign:{" "}
          <span className="text-foreground">{donorbox.campaignName}</span>
        </p>
      )}
      {donorbox.designation && (
        <p className="text-muted-foreground">
          Designation:{" "}
          <span className="text-foreground">{donorbox.designation}</span>
        </p>
      )}
      {donorbox.comment && (
        <p className="text-muted-foreground">
          Comment: <span className="text-foreground">{donorbox.comment}</span>
        </p>
      )}
      {(donorbox.donorName ||
        donorbox.donorEmail ||
        donorbox.donorEmployer) && (
        <p className="text-muted-foreground">
          Donor:{" "}
          <span className="text-foreground">
            {[donorbox.donorName, donorbox.donorEmail, donorbox.donorEmployer]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </p>
      )}
    </div>
  );
}
