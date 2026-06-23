import { useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetOrganization,
  useListOrganizations,
  useUpdateOrganization,
  useArchiveOrganization,
  useGetCurrentUser,
  getGetOrganizationQueryKey,
  getListOrganizationsQueryKey,
  type OrganizationDetail,
  type ListOrganizationsParams,
  type UpdateOrganizationBody,
  type ActiveStatus,
  type ConnectionStatus,
  type Enthusiasm,
  type StrategicAlignment,
  
  type NumberOfEmployees,
  type CapacityRating,
  type Priority,
} from "@workspace/api-client-react";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import { canSeeIdentity, canManageIdentity, displayOrganizationName, ANONYMOUS_LABEL } from "@/lib/visibility";
import { UnifiedActivityFeed } from "@/components/unified-activity-feed";
import { PinnedMediaCard } from "@/components/media-mentions-panel";
import { TasksPanel } from "@/components/tasks-panel";
import {
  LinkedGiftsCard,
  LinkedOpportunitiesCard,
} from "@/components/linked-records";
import {
  AddOrganizationPersonRoleDialog,
  AddOrganizationRelationDialog,
  EditPeopleEntityRoleDialog,
} from "@/components/add-role-dialogs";
import {
  RecordLayout,
  FieldCard,
  RelatedCard,
  AffiliationRow,
  HideInactiveToggle,
  type Highlight,
} from "@/components/record-layout";
import {
  InlineEditBoolean,
  InlineEditCurrency,
  InlineEditSelect,
  InlineEditText,
  InlineEditTextarea,
  EDIT_PENCIL_REVEAL,
  type InlineSelectOption,
} from "@/components/inline-edit";
import { InlineEditUserPicker, useUserNameMap } from "@/components/user-picker";
import { GivesThroughCard } from "@/components/gives-through-card";
import {
  InlineEditInterestsThematic,
  InlineEditInterestsAges,
  InlineEditInterestsGovModels,
  InlineEditMultiRegionPicker,
} from "@/components/multi-select-picker";
import { useQueryClient } from "@tanstack/react-query";
import {
  formatCurrency,
  formatDate,
  formatEnum,
  formatEnthusiasm,
  formatCapacity,
  formatCrunchbaseHandle,
  formatFacebookHandle,
  formatInstagramHandle,
  formatLinkedinHandle,
} from "@/lib/format";

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
  { value: "7-advocate", label: "7-Advocate" },
  { value: "6-supportive", label: "6-Supportive" },
  { value: "5-warm", label: "5-Warm" },
  { value: "4-neutral", label: "4-Neutral" },
  { value: "3-cool", label: "3-Cool" },
  { value: "2-unsupportive", label: "2-Unsupportive" },
  { value: "1-hostile", label: "1-Hostile" },
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
] as const satisfies ReadonlyArray<InlineSelectOption<string>>;

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
  { value: "tier_1k_10k", label: "$1k–$10k" },
  { value: "tier_10k_50k", label: "$10k–$50k" },
  { value: "tier_50k_250k", label: "$50k–$250k" },
  { value: "tier_250k_1m", label: "$250k–$1M" },
  { value: "tier_1m_plus", label: "$1M+" },
] as const satisfies ReadonlyArray<InlineSelectOption<CapacityRating>>;

const PRIORITY_OPTIONS = [
  { value: "top", label: "Top" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
] as const satisfies ReadonlyArray<InlineSelectOption<Priority>>;
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { PriorityTooltip } from "@/components/priority-tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  EmailsEditor,
  PhoneNumbersEditor,
  AddressesEditor,
} from "@/components/contact-info-editor";

export default function OrganizationDetail() {
  const [, params] = useRoute("/organizations/:id");
  const id = params?.id ?? "";

  const { data, isLoading, isError, error } = useGetOrganization(id, {
    query: { queryKey: getGetOrganizationQueryKey(id), enabled: !!id },
  });

  if (isLoading) {
    return (
      <div className="text-sm text-muted-foreground">Loading organization…</div>
    );
  }
  if (isError || !data) {
    return (
      <div className="space-y-4">
        <Link
          href="/organizations"
          className="text-sm text-primary hover:underline"
        >
          ← Back to funders
        </Link>
        <div className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Organization not found."}
        </div>
      </div>
    );
  }

  return <OrganizationView org={data} />;
}

function OrganizationView({ org }: { org: OrganizationDetail }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const userNames = useUserNameMap();
  const ownerDisplay = org.ownerUserId
    ? (userNames.get(org.ownerUserId) ?? org.ownerUserId)
    : "—";

  const viewer = useGetCurrentUser().data ?? null;
  const canSeeName = canSeeIdentity(org, viewer);
  const displayName = canSeeName ? org.name : ANONYMOUS_LABEL;

  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(org.name);

  const update = useUpdateOrganization({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetOrganizationQueryKey(org.id) }),
          queryClient.invalidateQueries({ queryKey: getListOrganizationsQueryKey() }),
        ]);
        toast({ title: "Organization updated" });
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

  const archive = useArchiveOrganization({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListOrganizationsQueryKey() });
        toast({ title: "Organization archived" });
        navigate("/organizations");
      },
      onError: (err: unknown) => {
        toast({
          title: "Archive failed",
          description: err instanceof Error ? err.message : String(err),
          variant: "destructive",
        });
      },
    },
  });

  function patch(body: UpdateOrganizationBody) {
    return update.mutateAsync({ id: org.id, data: body });
  }

  async function saveName() {
    const trimmed = nameValue.trim();
    if (!trimmed || trimmed === org.name) {
      setEditingName(false);
      return;
    }
    await patch({ name: trimmed });
    setEditingName(false);
  }

  const title = editingName ? (
    <Input
      value={nameValue}
      onChange={(e) => setNameValue(e.target.value)}
      className="h-11 max-w-md font-serif text-2xl font-bold"
      aria-label="Organization name"
      data-testid="input-organization-name"
      autoFocus
    />
  ) : (
    displayName
  );

  const actions = editingName ? (
    <>
      <Button
        onClick={saveName}
        disabled={update.isPending}
        data-testid="button-save-organization-name"
      >
        {update.isPending ? "Saving…" : "Save"}
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setNameValue(org.name);
          setEditingName(false);
        }}
        disabled={update.isPending}
      >
        Cancel
      </Button>
    </>
  ) : (
    <>
      {canSeeName && (
        <Button
          variant="outline"
          size="sm"
          className={EDIT_PENCIL_REVEAL}
          onClick={() => setEditingName(true)}
          data-testid="button-edit-organization-name"
        >
          Edit name
        </Button>
      )}
      <ConfirmDeleteDialog
        title={`Archive ${displayName}?`}
        description="It will be hidden from lists. An admin can restore it from the archived view."
        confirmLabel="Archive"
        triggerLabel="Archive"
        busyLabel="Archiving…"
        destructive={false}
        onConfirm={() => archive.mutateAsync({ id: org.id })}
        disabled={archive.isPending}
        triggerTestId="button-archive-organization"
        confirmTestId="button-confirm-archive-organization"
      />
    </>
  );

  const highlights: Highlight[] = [
    {
      label: (
        <span className="inline-flex items-center gap-1">
          Priority
          <PriorityTooltip />
        </span>
      ),
      value: (
        <InlineEditSelect
          label="Priority"
          testIdBase="organization-priority"
          value={org.priority ?? null}
          options={PRIORITY_OPTIONS}
          display={
            org.priority ? (
              <Badge variant={org.priority === "top" ? "default" : "outline"}>
                {formatEnum(org.priority)}
              </Badge>
            ) : (
              "—"
            )
          }
          onSave={(next) => patch({ priority: next })}
        />
      ),
      accent: true,
    },
    {
      label: "Capacity",
      value: (
        <InlineEditSelect
          label="Capacity rating"
          testIdBase="organization-capacity"
          value={org.capacityRating ?? null}
          options={CAPACITY_OPTIONS}
          display={formatCapacity(org.capacityRating)}
          onSave={(next) => patch({ capacityRating: next })}
        />
      ),
    },
    {
      label: "Connection",
      value: (
        <InlineEditSelect
          label="Connection status"
          testIdBase="organization-connection"
          value={org.connectionStatus ?? null}
          options={CONNECTION_STATUS_OPTIONS}
          display={formatEnum(org.connectionStatus)}
          onSave={(next) => patch({ connectionStatus: next })}
        />
      ),
    },
    {
      label: "Enthusiasm",
      value: (
        <InlineEditSelect
          label="Enthusiasm"
          testIdBase="organization-enthusiasm"
          value={org.enthusiasm ?? null}
          options={ENTHUSIASM_OPTIONS}
          display={formatEnthusiasm(org.enthusiasm)}
          onSave={(next) => patch({ enthusiasm: next })}
        />
      ),
    },
    {
      label: "Owner",
      value: (
        <InlineEditUserPicker
          testIdBase="organization-owner"
          value={org.ownerUserId ?? null}
          display={ownerDisplay}
          onSave={(next) => patch({ ownerUserId: next })}
        />
      ),
    },
    {
      label: "Lifetime giving",
      value: formatCurrency(org.lifetimeGiving),
    },
  ];

  const people = org.people ?? [];

  const [hideInactivePeople, setHideInactivePeople] = useState(false);
  const hasInactivePeople = people.some((p) => p.current === "past");
  const visiblePeople = (
    hideInactivePeople ? people.filter((p) => p.current !== "past") : people
  )
    .slice()
    // Primary contact first; Array.prototype.sort is stable so the original
    // order is preserved among the remaining (non-primary) people.
    .sort(
      (a, b) =>
        Number(b.primaryContact ?? false) - Number(a.primaryContact ?? false),
    );

  return (
    <RecordLayout
      backHref="/organizations"
      backLabel="Back to funders"
      title={title}
      typeBadge="Organization"
      subtitle={
        <div className="w-full space-y-2">
          <InlineEditSelect
            label="Subtype"
            testIdBase="organization-subtype"
            value={org.entityType ?? null}
            options={SUBTYPE_OPTIONS}
            display={formatEnum(org.entityType)}
            onSave={(next) => patch({ entityType: next })}
            align="left"
          />
          <InlineEditTextarea
            label="About"
            testIdBase="organization-about"
            value={org.about ?? null}
            placeholder="Add an overview of this organization…"
            display={
              org.about ? (
                <p className="whitespace-pre-wrap text-left text-sm text-foreground">
                  {org.about}
                </p>
              ) : (
                <span className="text-muted-foreground">Add an overview…</span>
              )
            }
            onSave={(next) => patch({ about: next })}
          />
        </div>
      }
      actions={actions}
      highlights={highlights}
      left={
        <>
          <FieldCard title="Details">
            <div className="space-y-4">
              <div className="space-y-1">
                <Row label="Active">
                  <InlineEditSelect
                    label="Active status"
                    testIdBase="organization-active-status"
                    value={org.activeStatus ?? null}
                    options={ACTIVE_STATUS_OPTIONS}
                    display={
                      org.activeStatus ? (
                        <Badge variant={org.activeStatus === "active" ? "default" : "outline"}>
                          {formatEnum(org.activeStatus)}
                        </Badge>
                      ) : (
                        "—"
                      )
                    }
                    onSave={(next) => patch({ activeStatus: next })}
                  />
                </Row>
                <Row label="Employees">
                  <InlineEditSelect
                    label="Number of employees"
                    testIdBase="organization-employees"
                    value={org.numberOfEmployees ?? null}
                    options={EMPLOYEES_OPTIONS}
                    display={
                      EMPLOYEES_OPTIONS.find((o) => o.value === org.numberOfEmployees)?.label ?? "—"
                    }
                    onSave={(next) => patch({ numberOfEmployees: next })}
                  />
                </Row>
                <Row label="Total assets">
                  <InlineEditCurrency
                    label="Total assets"
                    testIdBase="organization-total-assets"
                    value={org.totalAssets ?? null}
                    display={formatCurrency(org.totalAssets)}
                    onSave={(next) => patch({ totalAssets: next })}
                  />
                </Row>
                <Row label="Makes grants">
                  <InlineEditBoolean
                    label="Makes grants"
                    testIdBase="organization-issues-grants"
                    value={org.issuesGrants}
                    allowNull={false}
                    display={org.issuesGrants ? "Yes" : "No"}
                    onSave={(next) => patch({ issuesGrants: next ?? false })}
                  />
                </Row>
                <Row label="Makes PRIs">
                  <InlineEditBoolean
                    label="Makes PRIs"
                    testIdBase="organization-makes-pris"
                    value={org.makesPris ?? null}
                    display={
                      org.makesPris == null
                        ? "—"
                        : org.makesPris
                          ? "Yes"
                          : "No"
                    }
                    onSave={(next) => patch({ makesPris: next })}
                  />
                </Row>
                <Row label="Strategic alignment">
                  <InlineEditSelect
                    label="Strategic alignment"
                    testIdBase="organization-alignment"
                    value={org.strategicAlignment ?? null}
                    options={ALIGNMENT_OPTIONS}
                    display={formatEnum(org.strategicAlignment)}
                    onSave={(next) => patch({ strategicAlignment: next })}
                  />
                </Row>
                {canManageIdentity(org, viewer) && (
                  <Row label="Anonymous">
                    <InlineEditBoolean
                      label="Anonymous"
                      testIdBase="organization-anonymous"
                      value={org.anonymous}
                      allowNull={false}
                      display={org.anonymous ? "Yes" : "No"}
                      onSave={(next) => patch({ anonymous: next ?? false })}
                    />
                  </Row>
                )}
              </div>
              <Separator />
              <div className="space-y-4">
                <Row label="Other names">
                  <InlineEditText
                    label="Other names"
                    testIdBase="organization-other-names"
                    value={org.otherNames ?? null}
                    placeholder="Aliases, abbreviations…"
                    display={org.otherNames ?? "—"}
                    onSave={(next) => patch({ otherNames: next })}
                  />
                </Row>
                <TagRow label="Historical names" values={org.historicalNames} />
                <Row label="Tags">
                  <InlineEditText
                    label="Tags"
                    testIdBase="organization-tags"
                    value={org.tags ?? null}
                    placeholder="Comma-separated tags"
                    display={org.tags ?? "—"}
                    onSave={(next) => patch({ tags: next })}
                  />
                </Row>
                <div>
                  <div className="text-xs font-medium text-muted-foreground mb-1">
                    Details
                  </div>
                  <InlineEditTextarea
                    label="Details"
                    testIdBase="organization-details"
                    value={org.details ?? null}
                    placeholder="Add details…"
                    display={
                      org.details ? (
                        <p className="whitespace-pre-wrap text-left">{org.details}</p>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )
                    }
                    onSave={(next) => patch({ details: next })}
                  />
                </div>
              </div>
            </div>
          </FieldCard>

          <FieldCard
            title="Interests"
            empty={
              (org.interestsThematic?.length ?? 0) === 0 &&
              (org.interestsAges?.length ?? 0) === 0 &&
              (org.interestsGovModels?.length ?? 0) === 0 &&
              (org.regionIds?.length ?? 0) === 0 &&
              !org.priorityAreasNotes
            }
          >
            <div className="space-y-3">
              <TagEditRow label="Thematic">
                <InlineEditInterestsThematic
                  testIdBase="organization-interests-thematic"
                  value={org.interestsThematic ?? []}
                  onSave={(next) => patch({ interestsThematic: next })}
                />
              </TagEditRow>
              <TagEditRow label="Ages">
                <InlineEditInterestsAges
                  testIdBase="organization-interests-ages"
                  value={org.interestsAges ?? []}
                  onSave={(next) => patch({ interestsAges: next })}
                />
              </TagEditRow>
              <TagEditRow label="Gov models">
                <InlineEditInterestsGovModels
                  testIdBase="organization-interests-gov"
                  value={org.interestsGovModels ?? []}
                  onSave={(next) => patch({ interestsGovModels: next })}
                />
              </TagEditRow>
              <TagEditRow label="Regions">
                <InlineEditMultiRegionPicker
                  testIdBase="organization-regions"
                  value={org.regionIds ?? []}
                  onSave={(next) => patch({ regionIds: next })}
                />
              </TagEditRow>
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">
                  Priority areas notes
                </div>
                <InlineEditTextarea
                  label="Priority areas notes"
                  testIdBase="organization-priority-areas-notes"
                  value={org.priorityAreasNotes ?? null}
                  placeholder="Add priority areas notes…"
                  display={
                    org.priorityAreasNotes ? (
                      <p className="whitespace-pre-wrap text-left text-sm text-foreground">
                        {org.priorityAreasNotes}
                      </p>
                    ) : (
                      <span className="text-muted-foreground">
                        Add priority areas notes…
                      </span>
                    )
                  }
                  onSave={(next) => patch({ priorityAreasNotes: next })}
                />
              </div>
            </div>
          </FieldCard>

          <FieldCard
            title="Contact info"
            empty={
              (org.emails?.length ?? 0) === 0 &&
              (org.phoneNumbers?.length ?? 0) === 0 &&
              (org.addresses?.length ?? 0) === 0
            }
          >
            <div className="space-y-4">
              <EmailsEditor
                owner={{ kind: "organization", id: org.id }}
                emails={org.emails}
              />
              <Separator />
              <PhoneNumbersEditor
                owner={{ kind: "organization", id: org.id }}
                phoneNumbers={org.phoneNumbers}
              />
              <Separator />
              <AddressesEditor
                owner={{ kind: "organization", id: org.id }}
                addresses={org.addresses}
              />
            </div>
          </FieldCard>

          <FieldCard title="Web" defaultOpen={false}>
            <div className="space-y-1">
              <Row label="Website">
                <InlineEditText
                  label="Website"
                  testIdBase="organization-website"
                  value={org.website ?? null}
                  placeholder="https://…"
                  display={
                    org.website ? (
                      <a
                        href={org.website}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline break-all"
                      >
                        {org.website}
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
                  testIdBase="organization-email"
                  value={org.orgEmail ?? null}
                  display={org.orgEmail ?? "—"}
                  onSave={(next) => patch({ orgEmail: next })}
                />
              </Row>
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex flex-col">
                  <span className="text-xs font-medium text-muted-foreground">
                    Domain
                  </span>
                  <span className="text-[10px] italic text-muted-foreground/70">
                    auto-derived from email when blank
                  </span>
                </span>
                <span className="text-right">
                  <InlineEditText
                    label="Domain"
                    testIdBase="organization-email-domain"
                    value={org.emailDomain ?? null}
                    display={org.emailDomain ?? "—"}
                    onSave={(next) => patch({ emailDomain: next })}
                  />
                </span>
              </div>
              <Row label="LinkedIn">
                <InlineEditText
                  label="LinkedIn"
                  testIdBase="organization-linkedin"
                  value={org.linkedin ?? null}
                  display={
                    org.linkedin ? (
                      <a
                        href={org.linkedin}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline truncate"
                      >
                        {formatLinkedinHandle(org.linkedin)}
                      </a>
                    ) : (
                      "—"
                    )
                  }
                  onSave={(next) => patch({ linkedin: next })}
                />
              </Row>
              <Row label="Crunchbase">
                <InlineEditText
                  label="Crunchbase"
                  testIdBase="organization-crunchbase"
                  value={org.crunchbase ?? null}
                  display={
                    org.crunchbase ? (
                      <a
                        href={org.crunchbase}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline truncate"
                      >
                        {formatCrunchbaseHandle(org.crunchbase)}
                      </a>
                    ) : (
                      "—"
                    )
                  }
                  onSave={(next) => patch({ crunchbase: next })}
                />
              </Row>
              <Row label="Facebook">
                <InlineEditText
                  label="Facebook"
                  testIdBase="organization-facebook"
                  value={org.facebook ?? null}
                  display={
                    org.facebook ? (
                      <a
                        href={org.facebook}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline truncate"
                      >
                        {formatFacebookHandle(org.facebook)}
                      </a>
                    ) : (
                      "—"
                    )
                  }
                  onSave={(next) => patch({ facebook: next })}
                />
              </Row>
              <Row label="Instagram">
                <InlineEditText
                  label="Instagram"
                  testIdBase="organization-instagram"
                  value={org.instagram ?? null}
                  display={
                    org.instagram ? (
                      <a
                        href={org.instagram}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline truncate"
                      >
                        {formatInstagramHandle(org.instagram)}
                      </a>
                    ) : (
                      "—"
                    )
                  }
                  onSave={(next) => patch({ instagram: next })}
                />
              </Row>
            </div>
          </FieldCard>

          <div className="px-1 text-xs text-muted-foreground">
            Created {formatDate(org.createdAt)} • Updated{" "}
            {formatDate(org.updatedAt)}
          </div>
        </>
      }
      center={
        (() => {
          const primaryContact = (org.people ?? []).find((p) => p.primaryContact);
          const funderDefaultLinks: Partial<{ personIds: string[]; organizationIds: string[]; householdIds: string[]; opportunityIds: string[]; giftIds: string[] }> = primaryContact
            ? { personIds: [primaryContact.personId] }
            : {};
          return (
            <>
              <TasksPanel organizationId={org.id} defaultLinks={funderDefaultLinks} />
              <UnifiedActivityFeed
                organizationId={org.id}
                notesContext={{ organizationId: org.id, defaultLinks: funderDefaultLinks }}
                hideTasks
              />
            </>
          );
        })()
      }
      right={
        <>
          <PinnedMediaCard organizationId={org.id} />
          <LinkedOpportunitiesCard
            scope={{ organizationId: org.id }}
            title="Open opportunities"
            pledgeView="opportunities"
            status="open"
            emptyLabel="No open opportunities."
          />

          <RelatedCard
            title="People"
            count={visiblePeople.length}
            action={
              <div className="flex items-center gap-1">
                {hasInactivePeople ? (
                  <HideInactiveToggle
                    hidden={hideInactivePeople}
                    onToggle={() => setHideInactivePeople((v) => !v)}
                  />
                ) : null}
                <AddOrganizationPersonRoleDialog organizationId={org.id} />
              </div>
            }
          >
            {visiblePeople.length > 0 ? (
              <div>
                {visiblePeople.map((p) => {
                  const title =
                    p.externalTitleOrRole ??
                    (p.connection ? formatEnum(p.connection) : null);
                  const role =
                    [title, p.personEmail].filter(Boolean).join(" · ") ||
                    undefined;
                  return (
                    <div key={p.id} data-testid={`row-organization-person-${p.id}`}>
                      <AffiliationRow
                        name={p.personName ?? `Person ${p.personId}`}
                        href={`/individuals/${p.personId}`}
                        role={role}
                        primary={p.primaryContact ?? false}
                        hideStatusBadge
                        action={<EditPeopleEntityRoleDialog role={p} />}
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="px-2 py-2 text-sm text-muted-foreground">
                No people linked.
              </p>
            )}
          </RelatedCard>

          <RelatedOrganizationsCard org={org} />

          <GivesThroughCard donor={{ organizationId: org.id }} />

          <LinkedOpportunitiesCard
            scope={{ organizationId: org.id }}
            title="Pledges"
            pledgeView="pledges"
            emptyLabel="No pledges from this organization."
          />

          <LinkedGiftsCard scope={{ organizationId: org.id }} />
        </>
      }
    />
  );
}

function RelatedOrganizationsCard({
  org,
}: {
  org: OrganizationDetail;
}) {
  const childParams: ListOrganizationsParams = {
    parentOrganizationId: org.id,
    limit: 100,
  };
  const childrenQ = useListOrganizations(childParams, {
    query: { queryKey: getListOrganizationsQueryKey(childParams) },
  });
  const viewer = useGetCurrentUser().data ?? null;
  const parentId = org.parentOrganizationId ?? "";
  const parentQ = useGetOrganization(parentId, {
    query: {
      queryKey: getGetOrganizationQueryKey(parentId),
      enabled: !!org.parentOrganizationId,
    },
  });

  const [hideInactive, setHideInactive] = useState(false);
  // Only explicitly defunct funders are treated as inactive — spenddown
  // funders are still active givers and stay visible.
  const isInactiveOrg = (f: { activeStatus?: string | null }) =>
    f.activeStatus === "defunct";

  const allChildren = childrenQ.data?.data ?? [];
  const fullParent = org.parentOrganizationId ? (parentQ.data ?? null) : null;

  const hasInactive =
    allChildren.some(isInactiveOrg) ||
    (fullParent ? isInactiveOrg(fullParent) : false);
  const children =
    hideInactive ? allChildren.filter((c) => !isInactiveOrg(c)) : allChildren;
  const parent =
    fullParent && !(hideInactive && isInactiveOrg(fullParent))
      ? fullParent
      : null;
  const count = (parent ? 1 : 0) + children.length;

  return (
    <RelatedCard
      title="Organizations"
      count={count}
      action={
        <div className="flex items-center gap-1">
          {hasInactive ? (
            <HideInactiveToggle
              hidden={hideInactive}
              onToggle={() => setHideInactive((v) => !v)}
            />
          ) : null}
          <AddOrganizationRelationDialog organizationId={org.id} />
        </div>
      }
    >
      <div>
        {parent ? (
          <AffiliationRow
            name={displayOrganizationName(parent, viewer)}
            href={`/organizations/${parent.id}`}
            role="Parent organization"
            hideStatusBadge
          />
        ) : null}
        {children.map((c) => (
          <AffiliationRow
            key={c.id}
            name={displayOrganizationName(c, viewer)}
            href={`/organizations/${c.id}`}
            role="Subsidiary"
            hideStatusBadge
          />
        ))}
      </div>
    </RelatedCard>
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
