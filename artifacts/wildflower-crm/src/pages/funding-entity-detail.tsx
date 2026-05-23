import { useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetFunder,
  useUpdateFunder,
  useDeleteFunder,
  getGetFunderQueryKey,
  getListFundersQueryKey,
  type FunderDetail,
  type UpdateFunderBody,
} from "@workspace/api-client-react";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { formatDate, formatEnum, formatCapacity } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

export default function FundingEntityDetail() {
  const [, params] = useRoute("/funding-entities/:id");
  const id = params?.id ?? "";

  const { data, isLoading, isError, error } = useGetFunder(id, {
    query: { queryKey: getGetFunderQueryKey(id), enabled: !!id },
  });

  if (isLoading) {
    return (
      <div className="text-sm text-muted-foreground">Loading funder…</div>
    );
  }
  if (isError || !data) {
    return (
      <div className="space-y-4">
        <Link
          href="/funding-entities"
          className="text-sm text-primary hover:underline"
        >
          ← Back to funders
        </Link>
        <div className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Funder not found."}
        </div>
      </div>
    );
  }

  return <FunderView funder={data} />;
}

function FunderView({ funder }: { funder: FunderDetail }) {
  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/funding-entities"
          className="text-sm text-primary hover:underline"
        >
          ← Back to funders
        </Link>
      </div>

      <NameHeader funder={funder} />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Active">
              {funder.activeStatus ? (
                <Badge
                  variant={
                    funder.activeStatus === "active" ? "default" : "outline"
                  }
                >
                  {formatEnum(funder.activeStatus)}
                </Badge>
              ) : (
                "—"
              )}
            </Row>
            <Row label="Connection">{formatEnum(funder.connectionStatus)}</Row>
            <Row label="Enthusiasm">{formatEnum(funder.enthusiasm)}</Row>
            <Row label="Strategic alignment">
              {formatEnum(funder.strategicAlignment)}
            </Row>
            <Row label="National priorities">
              {funder.nationalPriorities == null
                ? "—"
                : funder.nationalPriorities
                  ? "Yes"
                  : "No"}
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Organization</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Subtype">{formatEnum(funder.fundingEntitySubtype)}</Row>
            <Row label="Employees">
              {formatEnum(funder.numberOfEmployees)}
            </Row>
            <Row label="Capacity">{formatCapacity(funder.capacityRating)}</Row>
            <Row label="Makes PRIs">
              {funder.makesPris == null
                ? "—"
                : funder.makesPris
                  ? "Yes"
                  : "No"}
            </Row>
            <Row label="Owner">{funder.ownerUserId ?? "—"}</Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Web</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Website">
              {funder.website ? (
                <a
                  href={funder.website}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline break-all"
                >
                  {funder.website}
                </a>
              ) : (
                "—"
              )}
            </Row>
            <Row label="Email">{funder.orgEmail ?? "—"}</Row>
            <Row label="Domain">{funder.emailDomain ?? "—"}</Row>
            <Row label="LinkedIn">{funder.linkedin ?? "—"}</Row>
            <Row label="Crunchbase">{funder.crunchbase ?? "—"}</Row>
          </CardContent>
        </Card>
      </div>

      {(funder.interestsThematic?.length ||
        funder.interestsAges?.length ||
        funder.interestsGovModels?.length ||
        funder.regionIds?.length ||
        funder.priorityAreasNotes) && (
        <Card>
          <CardHeader>
            <CardTitle>Interests</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <TagRow label="Thematic" values={funder.interestsThematic} />
            <TagRow label="Ages" values={funder.interestsAges} />
            <TagRow label="Gov models" values={funder.interestsGovModels} />
            <TagRow label="Regions" values={funder.regionIds} />
            {funder.priorityAreasNotes && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  Priority areas notes
                </div>
                <p className="whitespace-pre-wrap">{funder.priorityAreasNotes}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>People</CardTitle>
          </CardHeader>
          <CardContent>
            {funder.people && funder.people.length > 0 ? (
              <ul className="space-y-2 text-sm">
                {funder.people.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between gap-2"
                    data-testid={`row-funder-person-${p.id}`}
                  >
                    <Link
                      href={`/individuals/${p.personId}`}
                      className="text-primary hover:underline truncate"
                    >
                      {p.externalTitleOrRole ?? `Person ${p.personId}`}
                    </Link>
                    <span className="text-muted-foreground text-xs whitespace-nowrap">
                      {formatEnum(p.connection)}
                      {p.current && p.current !== "current"
                        ? ` (${formatEnum(p.current)})`
                        : ""}
                      {p.primaryContact ? " • primary" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No people linked.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Emails & addresses</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">
                Emails
              </div>
              {funder.emails && funder.emails.length > 0 ? (
                <ul className="space-y-1 text-sm">
                  {funder.emails.map((e) => (
                    <li
                      key={e.id}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="truncate">{e.email}</span>
                      <span className="text-muted-foreground text-xs">
                        {e.isPreferred ? "preferred • " : ""}
                        {formatEnum(e.validity)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No emails.</p>
              )}
            </div>
            <Separator />
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">
                Addresses
              </div>
              {funder.addresses && funder.addresses.length > 0 ? (
                <ul className="space-y-2 text-sm">
                  {funder.addresses.map((a) => (
                    <li key={a.id}>
                      {[a.street, a.cityName, a.stateCode, a.postalCode]
                        .filter(Boolean)
                        .join(", ") || "—"}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No addresses.</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {(funder.details ||
        funder.otherNames ||
        funder.historicalNames?.length ||
        funder.tags) && (
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {funder.otherNames && (
              <Row label="Other names">{funder.otherNames}</Row>
            )}
            <TagRow label="Historical names" values={funder.historicalNames} />
            {funder.tags && <Row label="Tags">{funder.tags}</Row>}
            {funder.details && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  Details
                </div>
                <p className="whitespace-pre-wrap">{funder.details}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="text-xs text-muted-foreground">
        Created {formatDate(funder.createdAt)} • Updated{" "}
        {formatDate(funder.updatedAt)}
      </div>
    </div>
  );
}

function NameHeader({ funder }: { funder: FunderDetail }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(funder.name);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const del = useDeleteFunder({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListFundersQueryKey() });
        toast({ title: "Funder deleted" });
        navigate("/funding-entities");
      },
      onError: (err: unknown) => {
        toast({
          title: "Delete failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });
  const update = useUpdateFunder({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: getGetFunderQueryKey(funder.id),
          }),
          queryClient.invalidateQueries({
            queryKey: getListFundersQueryKey(),
          }),
        ]);
        setEditing(false);
        toast({ title: "Funder updated" });
      },
      onError: (err: unknown) => {
        toast({
          title: "Update failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  if (editing) {
    const trimmed = value.trim();
    const dirty = trimmed.length > 0 && trimmed !== funder.name;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="text-2xl font-serif font-bold h-12 max-w-xl"
          aria-label="Funder name"
          data-testid="input-funder-name"
          autoFocus
        />
        <Button
          onClick={() => {
            const body: UpdateFunderBody = { name: trimmed };
            update.mutate({ id: funder.id, data: body });
          }}
          disabled={!dirty || update.isPending}
          data-testid="button-save-funder-name"
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setValue(funder.name);
            setEditing(false);
          }}
          disabled={update.isPending}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-start justify-between gap-4">
      <h1 className="text-3xl font-serif font-bold text-foreground">
        {funder.name}
      </h1>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditing(true)}
          data-testid="button-edit-funder-name"
        >
          Edit name
        </Button>
        <ConfirmDeleteDialog
          title={`Delete ${funder.name}?`}
          description="This funder and any direct references to it will be removed. Linked opportunities and gifts may need to be reassigned."
          onConfirm={() => del.mutateAsync({ id: funder.id })}
          disabled={del.isPending}
          triggerTestId="button-delete-funder"
          confirmTestId="button-confirm-delete-funder"
        />
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

function TagRow({
  label,
  values,
}: {
  label: string;
  values?: string[] | null;
}) {
  if (!values || values.length === 0) return null;
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">
        {label}
      </div>
      <div className="flex flex-wrap gap-1">
        {values.map((v) => (
          <Badge key={v} variant="secondary">
            {formatEnum(v)}
          </Badge>
        ))}
      </div>
    </div>
  );
}
