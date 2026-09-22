import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { QuickbooksRulesSection } from "@/pages/admin";

export default function ReconciliationRulesPage() {
  const isAdmin = useIsAdmin();

  if (!isAdmin) {
    return (
      <div className="space-y-4">
        <Button asChild variant="outline" size="sm">
          <a href="/reconciliation/deposits">
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Back to reconciliation
          </a>
        </Button>
        <p className="text-sm text-muted-foreground">
          Only admins can view or edit reconciliation rules.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
          <a href="/reconciliation/deposits">
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            Back to reconciliation
          </a>
        </Button>
        <h1 className="text-3xl font-serif font-bold text-foreground">
          Reconciliation rules
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Review the business rules applied to incoming QuickBooks payments.
          Rules run from top to bottom; the first enabled match wins.
        </p>
      </div>
      <QuickbooksRulesSection />
    </div>
  );
}
