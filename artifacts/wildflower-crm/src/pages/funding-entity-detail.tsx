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
  type ActiveStatus,
  type ConnectionStatus,
  type Enthusiasm,
  type StrategicAlignment,
  type FundingEntitySubtype,
  type NumberOfEmployees,
  type CapacityRating,
} from "@workspace/api-client-react";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import {
  InlineEditBoolean,
  InlineEditSelect,
  InlineEditText,
  type InlineSelectOption,
} from "@/components/inline-edit";
import { InlineEditUserPicker, useUserNameMap } from "@/components/user-picker";
import {
  InlineEditInterestsThematic,
  InlineEditInterestsAges,
  InlineEditInterestsGovModels,
  InlineEditMultiRegionPicker,
} from "@/components/multi-select-picker";
import { useQueryClient } from "@tanstack/react-query";
import { formatDate, formatEnum, formatCapacity } from "@/lib/format";

const ACTIVE_STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "defunct", label: "Defunct" },
  { value: "spenddown", label: "Spend-down" },
] as const satisfies ReadonlyArray<InlineSelectOption<ActiveStatus>>;

const CONNECTION_STATUS_OPTIONS = [
  { value: "connected", label: "Connected" },
  { value: "have_a_connector", label: "Have a connector" },
  { value: "no_connection", label: "No connection" },
] as const satisfies ReadonlyArray<InlineSelectOption<ConnectionStatus>>;

const ENTHUSIASM_OPTIONS = [
  { value: "advocate", label: "Advocate" },
  { value: "supportive", label: "Supportive" },
  { value: "warm", label: "Warm" },
  { value: "neutral", label: "Neutral" },
  { value: "unsupportive", label: "Unsupportive" },
] as const satisfies ReadonlyArray<InlineSelectOption<Enthusiasm>>;

const ALIGNMENT_OPTIONS = [
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
] as const satisfies ReadonlyArray<InlineSelectOption<StrategicAlignment>>;

const SUBTYPE_OPTIONS = [
  { value: "family_foundation", label: "Family foundation" },
  { value: "institutional_foundation", label: "Institutional foundation" },
  { value: "corporate_foundation", label: "Corporate foundation" },
  { value: "community_foundation", label: "Community foundation" },
  { value: "bank_foundation", label: "Bank foundation" },
  { value: "family_office_trust", label: "Family office / trust" },
  { value: "intermediary", label: "Intermediary" },
  { value: "government", label: "Government" },
  { value: "nonprofit", label: "Nonprofit" },
  { value: "corporation", label: "Corporation" },
  { value: "capital_provider", label: "Capital provider" },
  { value: "philanthropic_advisor", label: "Philanthropic advisor" },
  { value: "cdfi", label: "CDFI" },
  { value: "education_forprofit", label: "Education for-profit" },
  { value: "competition", label: "Competition" },
  { value: "public_private", label: "Public–private" },
  { value: "daf_platform", label: "DAF platform" },
  { value: "platform", label: "Platform" },
] as const satisfies ReadonlyArray<InlineSelectOption<FundingEntitySubtype>>;

const EMPLOYEES_OPTIONS = [
  { value: "e_1", label: "1" },
  { value: "e_2_10", label: "2–10" },
  { value: "e_11_50", label: "11–50" },
  { value: "e_51_250", label: "51–250" },
  { value: "e_251_1000", label: "251–1,000" },
  { value: "e_1001_10000", label: "1,001–10,000" },
  { value: "e_10000_plus", label: "10,000+" },
] as const satisfies ReadonlyArray<InlineSelectOption<NumberOfEmployees>>;

const CAPACITY_OPTIONS = [
  { value: "tier_10k_50k", label: "$10k–$50k" },
  { value: "tier_50k_250k", label: "$50k–$250k" },
  { value: "tier_250k_1m", label: "$250k–$1M" },
  { value: "tier_1m_plus", label: "$1M+" },
] as const satisfies ReadonlyArray<InlineSelectOption<CapacityRating>>;
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
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const userNames = useUserNameMap();
  const ownerDisplay = funder.ownerUserId
    ? (userNames.get(funder.ownerUserId) ?? funder.ownerUserId)
    : "—";

  const update = useUpdateFunder({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetFunderQueryKey(funder.id) }),
          queryClient.invalidateQueries({ queryKey: getListFundersQueryKey() }),
        ]);
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

  function patch(body: UpdateFunderBody) {
    return update.mutateAsync({ id: funder.id, data: body });
  }

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
              <InlineEditSelect
                label="Active status"
                testIdBase="funder-active-status"
                value={funder.activeStatus ?? null}
                options={ACTIVE_STATUS_OPTIONS}
                display={
                  funder.activeStatus ? (
                    <Badge variant={funder.activeStatus === "active" ? "default" : "outline"}>
                      {formatEnum(funder.activeStatus)}
                    </Badge>
                  ) : (
                    "—"
                  )
                }
                onSave={(next) => patch({ activeStatus: next })}
              />
            </Row>
            <Row label="Connection">
              <InlineEditSelect
                label="Connection status"
                testIdBase="funder-connection"
                value={funder.connectionStatus ?? null}
                options={CONNECTION_STATUS_OPTIONS}
                display={formatEnum(funder.connectionStatus)}
                onSave={(next) => patch({ connectionStatus: next })}
              />
            </Row>
            <Row label="Enthusiasm">
              <InlineEditSelect
                label="Enthusiasm"
                testIdBase="funder-enthusiasm"
                value={funder.enthusiasm ?? null}
                options={ENTHUSIASM_OPTIONS}
                display={formatEnum(funder.enthusiasm)}
                onSave={(next) => patch({ enthusiasm: next })}
              />
            </Row>
            <Row label="Strategic alignment">
              <InlineEditSelect
                label="Strategic alignment"
                testIdBase="funder-alignment"
                value={funder.strategicAlignment ?? null}
                options={ALIGNMENT_OPTIONS}
                display={formatEnum(funder.strategicAlignment)}
                onSave={(next) => patch({ strategicAlignment: next })}
              />
            </Row>
            <Row label="National priorities">
              <InlineEditBoolean
                label="National priorities"
                testIdBase="funder-national-priorities"
                value={funder.nationalPriorities ?? null}
                display={
                  funder.nationalPriorities == null
                    ? "—"
                    : funder.nationalPriorities
                      ? "Yes"
                      : "No"
                }
                onSave={(next) => patch({ nationalPriorities: next })}
              />
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Organization</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Subtype">
              <InlineEditSelect
                label="Subtype"
                testIdBase="funder-subtype"
                value={funder.fundingEntitySubtype ?? null}
                options={SUBTYPE_OPTIONS}
                display={formatEnum(funder.fundingEntitySubtype)}
                onSave={(next) => patch({ fundingEntitySubtype: next })}
              />
            </Row>
            <Row label="Employees">
              <InlineEditSelect
                label="Number of employees"
                testIdBase="funder-employees"
                value={funder.numberOfEmployees ?? null}
                options={EMPLOYEES_OPTIONS}
                display={formatEnum(funder.numberOfEmployees)}
                onSave={(next) => patch({ numberOfEmployees: next })}
              />
            </Row>
            <Row label="Capacity">
              <InlineEditSelect
                label="Capacity rating"
                testIdBase="funder-capacity"
                value={funder.capacityRating ?? null}
                options={CAPACITY_OPTIONS}
                display={formatCapacity(funder.capacityRating)}
                onSave={(next) => patch({ capacityRating: next })}
              />
            </Row>
            <Row label="Makes PRIs">
              <InlineEditBoolean
                label="Makes PRIs"
                testIdBase="funder-makes-pris"
                value={funder.makesPris ?? null}
                display={
                  funder.makesPris == null
                    ? "—"
                    : funder.makesPris
                      ? "Yes"
                      : "No"
                }
                onSave={(next) => patch({ makesPris: next })}
              />
            </Row>
            <Row label="Owner">
              <InlineEditUserPicker
                testIdBase="funder-owner"
                value={funder.ownerUserId ?? null}
                display={ownerDisplay}
                onSave={(next) => patch({ ownerUserId: next })}
              />
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Web</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Website">
              <InlineEditText
                label="Website"
                testIdBase="funder-website"
                value={funder.website ?? null}
                placeholder="https://…"
                display={
                  funder.website ? (
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
                  )
                }
                onSave={(next) => patch({ website: next })}
              />
            </Row>
            <Row label="Email">
              <InlineEditText
                label="Email"
                testIdBase="funder-email"
                value={funder.orgEmail ?? null}
                display={funder.orgEmail ?? "—"}
                onSave={(next) => patch({ orgEmail: next })}
              />
            </Row>
            <Row label="Domain">{funder.emailDomain ?? "—"}</Row>
            <Row label="LinkedIn">
              <InlineEditText
                label="LinkedIn"
                testIdBase="funder-linkedin"
                value={funder.linkedin ?? null}
                display={funder.linkedin ?? "—"}
                onSave={(next) => patch({ linkedin: next })}
              />
            </Row>
            <Row label="Crunchbase">
              <InlineEditText
                label="Crunchbase"
                testIdBase="funder-crunchbase"
                value={funder.crunchbase ?? null}
                display={funder.crunchbase ?? "—"}
                onSave={(next) => patch({ crunchbase: next })}
              />
            </Row>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Interests</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <TagEditRow label="Thematic">
            <InlineEditInterestsThematic
              testIdBase="funder-interests-thematic"
              value={funder.interestsThematic ?? []}
              onSave={(next) => patch({ interestsThematic: next })}
            />
          </TagEditRow>
          <TagEditRow label="Ages">
            <InlineEditInterestsAges
              testIdBase="funder-interests-ages"
              value={funder.interestsAges ?? []}
              onSave={(next) => patch({ interestsAges: next })}
            />
          </TagEditRow>
          <TagEditRow label="Gov models">
            <InlineEditInterestsGovModels
              testIdBase="funder-interests-gov"
              value={funder.interestsGovModels ?? []}
              onSave={(next) => patch({ interestsGovModels: next })}
            />
          </TagEditRow>
          <TagEditRow label="Regions">
            <InlineEditMultiRegionPicker
              testIdBase="funder-regions"
              value={funder.regionIds ?? []}
              onSave={(next) => patch({ regionIds: next })}
            />
          </TagEditRow>
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

function TagEditRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">
        {label}
      </div>
      {children}
    </div>
  );
}
