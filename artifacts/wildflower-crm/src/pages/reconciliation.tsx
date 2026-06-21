import { useState } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { QbMoneyWorklist } from "@/components/reconciliation-qb-worklist";
import { StrayStripeWorklist } from "@/components/reconciliation-stray-stripe";
import { StrayGiftsWorklist } from "@/components/reconciliation-stray-gifts";

/* ────────────────────────────────────────────────────────────────────────
 * Reconciliation workspace.
 *
 * The workspace is ANCHORED on QuickBooks: every gift should map to a
 * QuickBooks money event, and only some (card/online) also carry Stripe. The
 * main worklist turns QuickBooks money into gifts; because that anchor leaves
 * two record sets out, each gets its own stray worklist:
 *   1. QuickBooks money → gifts   (the main queue; QB is required to book a gift)
 *   2. Stripe with no QuickBooks record   (surface + investigate only)
 *   3. Gifts with no QuickBooks record    (broad, filterable anomaly list)
 * ──────────────────────────────────────────────────────────────────────── */

type Worklist = "qb" | "stray_stripe" | "stray_gifts";

const WORKLISTS: { key: Worklist; label: string; blurb: string }[] = [
  {
    key: "qb",
    label: "QuickBooks money → gifts",
    blurb:
      "One card per QuickBooks money event. Match each to a donor and gift — attach an opportunity to mint a gift or latch a pledge. Stripe gross wins when a charge backs the money. A QuickBooks record is required to book a gift here.",
  },
  {
    key: "stray_stripe",
    label: "Stripe with no QuickBooks record",
    blurb:
      "Stripe payouts that never matched a QuickBooks deposit. Surface-and-investigate only — use the search to hunt the matching QuickBooks deposit, then book the gift from the main worklist.",
  },
  {
    key: "stray_gifts",
    label: "Gifts with no QuickBooks record",
    blurb:
      "Every gift should map to a QuickBooks money event. These gifts carry none — investigate them. A gift with a Stripe charge but no QuickBooks record is a high-priority anomaly.",
  },
];

export default function Reconciliation() {
  const [worklist, setWorklist] = useState<Worklist>("qb");
  const active = WORKLISTS.find((w) => w.key === worklist) ?? WORKLISTS[0];

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <Card>
        <CardHeader>
          <CardTitle>Reconciliation</CardTitle>
          <CardDescription>
            A QuickBooks-anchored workspace for turning incoming money into
            trustworthy gifts. Work the main queue; the two stray lists surface
            what falls outside the QuickBooks anchor.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1">
            {WORKLISTS.map((w) => (
              <Button
                key={w.key}
                variant={worklist === w.key ? "default" : "outline"}
                size="sm"
                onClick={() => setWorklist(w.key)}
                data-testid={`worklist-${w.key}`}
              >
                {w.label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{active.blurb}</p>
        </CardContent>
      </Card>

      {worklist === "qb" ? (
        <QbMoneyWorklist />
      ) : worklist === "stray_stripe" ? (
        <StrayStripeWorklist />
      ) : (
        <StrayGiftsWorklist />
      )}
    </div>
  );
}
