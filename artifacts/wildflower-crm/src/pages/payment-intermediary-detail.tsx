import { Link, useRoute } from "wouter";
import {
  useGetPaymentIntermediary,
  getGetPaymentIntermediaryQueryKey,
} from "@workspace/api-client-react";
import { formatEnum, formatDate } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

export default function PaymentIntermediaryDetail() {
  const [, params] = useRoute<{ id: string }>("/payment-intermediaries/:id");
  const id = params?.id ?? "";

  const { data, isLoading, isError, error } = useGetPaymentIntermediary(id, {
    query: { queryKey: getGetPaymentIntermediaryQueryKey(id), enabled: !!id },
  });

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  if (isError || !data) {
    return (
      <div className="space-y-4">
        <Link href="/payment-intermediaries" className="text-sm text-primary hover:underline">
          ← Back to payment intermediaries
        </Link>
        <div className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Payment intermediary not found."}
        </div>
      </div>
    );
  }

  const emails = data.emails ?? [];
  const people = data.people ?? [];

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link href="/payment-intermediaries" className="text-sm text-primary hover:underline">
          ← Payment Intermediaries
        </Link>
      </div>

      <div className="space-y-1">
        <h1 className="text-3xl font-serif font-bold text-foreground">{data.name}</h1>
        {data.type && (
          <Badge variant="outline" className="mt-1">{formatEnum(data.type)}</Badge>
        )}
      </div>

      <div className="rounded-lg border bg-card p-4 space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Details
        </h2>
        <Separator />
        <dl className="grid grid-cols-[160px_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">Name</dt>
          <dd>{data.name}</dd>
          <dt className="text-muted-foreground">Type</dt>
          <dd>{data.type ? formatEnum(data.type) : "—"}</dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd>{formatDate(data.createdAt)}</dd>
          <dt className="text-muted-foreground">Updated</dt>
          <dd>{formatDate(data.updatedAt)}</dd>
        </dl>
      </div>

      {emails.length > 0 && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Email addresses
          </h2>
          <Separator />
          <ul className="space-y-1">
            {emails.map((e) => (
              <li key={e.id} className="text-sm">
                <a href={`mailto:${e.email}`} className="text-primary hover:underline">
                  {e.email}
                </a>
                {e.type && (
                  <span className="ml-2 text-muted-foreground">({formatEnum(e.type)})</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {people.length > 0 && (
        <div className="rounded-lg border bg-card p-4 space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Associated people
          </h2>
          <Separator />
          <ul className="space-y-1">
            {people.map((p) => (
              <li key={p.id} className="text-sm">
                {p.personId ? (
                  <Link
                    href={`/individuals/${p.personId}`}
                    className="text-primary hover:underline"
                  >
                    {p.personName ?? p.personId}
                  </Link>
                ) : (
                  <span>{p.personName ?? "—"}</span>
                )}
                {p.connection && (
                  <span className="ml-2 text-muted-foreground">({formatEnum(p.connection)})</span>
                )}
                {p.current === "past" && (
                  <span className="ml-2 text-xs text-muted-foreground/60 italic">past</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
