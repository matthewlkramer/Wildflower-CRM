import { useState } from "react";
import { Link, useLocation, useRoute } from "wouter";
import {
  useGetPerson,
  useUpdatePerson,
  useDeletePerson,
  getGetPersonQueryKey,
  getListPeopleQueryKey,
  type PersonDetail,
  type UpdatePersonBody,
  type Pronouns,
} from "@workspace/api-client-react";
import { ConfirmDeleteDialog } from "@/components/confirm-delete-dialog";
import {
  InlineEditBoolean,
  InlineEditSelect,
  InlineEditText,
  type InlineSelectOption,
} from "@/components/inline-edit";
import { InlineEditUserPicker, useUserNameMap } from "@/components/user-picker";
import { useQueryClient } from "@tanstack/react-query";
import { formatDate, formatEnum } from "@/lib/format";

const PRONOUNS_OPTIONS = [
  { value: "he_him_his", label: "he / him / his" },
  { value: "she_her_hers", label: "she / her / hers" },
  { value: "they_them_theirs", label: "they / them / theirs" },
  { value: "other", label: "Other" },
] as const satisfies ReadonlyArray<InlineSelectOption<Pronouns>>;
import { useToast } from "@/hooks/use-toast";
import { personDisplayName } from "@/lib/person";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

export default function IndividualDetail() {
  const [, params] = useRoute("/individuals/:id");
  const id = params?.id ?? "";

  const { data, isLoading, isError, error } = useGetPerson(id, {
    query: { queryKey: getGetPersonQueryKey(id), enabled: !!id },
  });

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading person…</div>;
  }
  if (isError || !data) {
    return (
      <div className="space-y-4">
        <Link href="/individuals" className="text-sm text-primary hover:underline">
          ← Back to individuals
        </Link>
        <div className="text-sm text-destructive">
          {error instanceof Error ? error.message : "Person not found."}
        </div>
      </div>
    );
  }

  return <PersonView person={data} />;
}

function PersonView({ person }: { person: PersonDetail }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const userNames = useUserNameMap();
  const ownerDisplay = person.ownerUserId
    ? (userNames.get(person.ownerUserId) ?? person.ownerUserId)
    : "—";

  const update = useUpdatePerson({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetPersonQueryKey(person.id) }),
          queryClient.invalidateQueries({ queryKey: getListPeopleQueryKey() }),
        ]);
        toast({ title: "Person updated" });
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

  function patch(body: UpdatePersonBody) {
    return update.mutateAsync({ id: person.id, data: body });
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href="/individuals" className="text-sm text-primary hover:underline">
          ← Back to individuals
        </Link>
      </div>

      <NameHeader person={person} />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Basics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Prefix">
              <InlineEditText label="Prefix" testIdBase="person-prefix"
                value={person.prefix ?? null} display={person.prefix ?? "—"}
                onSave={(next) => patch({ prefix: next })} />
            </Row>
            <Row label="First">
              <InlineEditText label="First name" testIdBase="person-first"
                value={person.firstName ?? null} display={person.firstName ?? "—"}
                onSave={(next) => patch({ firstName: next })} />
            </Row>
            <Row label="Middle">
              <InlineEditText label="Middle name" testIdBase="person-middle"
                value={person.middleName ?? null} display={person.middleName ?? "—"}
                onSave={(next) => patch({ middleName: next })} />
            </Row>
            <Row label="Last">
              <InlineEditText label="Last name" testIdBase="person-last"
                value={person.lastName ?? null} display={person.lastName ?? "—"}
                onSave={(next) => patch({ lastName: next })} />
            </Row>
            <Row label="Suffix">
              <InlineEditText label="Suffix" testIdBase="person-suffix"
                value={person.suffix ?? null} display={person.suffix ?? "—"}
                onSave={(next) => patch({ suffix: next })} />
            </Row>
            <Row label="Nickname">
              <InlineEditText label="Nickname" testIdBase="person-nickname"
                value={person.nickname ?? null} display={person.nickname ?? "—"}
                onSave={(next) => patch({ nickname: next })} />
            </Row>
            <Row label="Pronouns">
              <InlineEditSelect label="Pronouns" testIdBase="person-pronouns"
                value={person.pronouns ?? null} options={PRONOUNS_OPTIONS}
                display={formatEnum(person.pronouns)}
                onSave={(next) => patch({ pronouns: next })} />
            </Row>
            <Row label="Status">
              <InlineEditBoolean
                label="Deceased"
                testIdBase="person-deceased"
                value={person.deceased ?? null}
                trueLabel="Deceased"
                falseLabel="Living"
                allowNull={false}
                display={
                  person.deceased == null
                    ? "—"
                    : person.deceased
                      ? <Badge variant="outline">Deceased</Badge>
                      : "Living"
                }
                onSave={(next) => patch({ deceased: next ?? false })}
              />
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Engagement</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Last contacted">{formatDate(person.lastContacted)}</Row>
            <Row label="Interactions">{person.interactionCount ?? "—"}</Row>
            <Row label="Owner">
              <InlineEditUserPicker testIdBase="person-owner"
                value={person.ownerUserId ?? null}
                display={ownerDisplay}
                onSave={(next) => patch({ ownerUserId: next })} />
            </Row>
            <Row label="Region">
              <InlineEditText label="Region" testIdBase="person-region"
                value={person.currentHomeRegionId ?? null} display={person.currentHomeRegionId ?? "—"}
                onSave={(next) => patch({ currentHomeRegionId: next })} />
            </Row>
            <Row label="Children at WF">{person.childrenAtWf ?? "—"}</Row>
            <Row label="Newsletter">
              <InlineEditBoolean
                label="Newsletter subscribed"
                testIdBase="person-newsletter"
                value={person.newsletter ?? null}
                trueLabel="Subscribed"
                falseLabel="Not subscribed"
                allowNull={false}
                display={
                  person.unsubscribedToNewsletter
                    ? "Unsubscribed"
                    : person.newsletter == null
                      ? "—"
                      : person.newsletter
                        ? "Subscribed"
                        : "Not subscribed"
                }
                onSave={(next) => patch({ newsletter: next ?? false })}
              />
            </Row>
            <Row label="Unsubscribed">
              <InlineEditBoolean
                label="Unsubscribed to newsletter"
                testIdBase="person-unsubscribed"
                value={person.unsubscribedToNewsletter ?? null}
                allowNull={false}
                display={
                  person.unsubscribedToNewsletter == null
                    ? "—"
                    : person.unsubscribedToNewsletter
                      ? "Yes"
                      : "No"
                }
                onSave={(next) => patch({ unsubscribedToNewsletter: next ?? false })}
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
              <InlineEditText label="Website" testIdBase="person-website"
                value={person.website ?? null} placeholder="https://…"
                display={
                  person.website ? (
                    <a href={person.website} target="_blank" rel="noreferrer"
                      className="text-primary hover:underline break-all">
                      {person.website}
                    </a>
                  ) : "—"
                }
                onSave={(next) => patch({ website: next })} />
            </Row>
            <Row label="LinkedIn">
              <InlineEditText label="LinkedIn" testIdBase="person-linkedin"
                value={person.linkedin ?? null} display={person.linkedin ?? "—"}
                onSave={(next) => patch({ linkedin: next })} />
            </Row>
            <Row label="X">
              <InlineEditText label="X" testIdBase="person-x"
                value={person.x ?? null} display={person.x ?? "—"}
                onSave={(next) => patch({ x: next })} />
            </Row>
            <Row label="Meeting link">
              <InlineEditText label="Meeting link" testIdBase="person-meeting-link"
                value={person.meetingLink ?? null} display={person.meetingLink ?? "—"}
                onSave={(next) => patch({ meetingLink: next })} />
            </Row>
          </CardContent>
        </Card>
      </div>

      {(person.interestsThematic?.length ||
        person.interestsAges?.length ||
        person.interestsGovModels?.length ||
        person.regionIds?.length) && (
        <Card>
          <CardHeader>
            <CardTitle>Interests</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <TagRow label="Thematic" values={person.interestsThematic} />
            <TagRow label="Ages" values={person.interestsAges} />
            <TagRow label="Gov models" values={person.interestsGovModels} />
            <TagRow label="Regions" values={person.regionIds} />
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Affiliations</CardTitle>
          </CardHeader>
          <CardContent>
            {person.roles && person.roles.length > 0 ? (
              <ul className="space-y-2 text-sm">
                {person.roles.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center justify-between gap-2"
                    data-testid={`row-person-role-${r.id}`}
                  >
                    <span className="truncate">
                      {r.externalTitleOrRole ?? formatEnum(r.entityType)}
                      {r.funderId
                        ? ` @ ${r.funderId}`
                        : r.organizationId
                          ? ` @ ${r.organizationId}`
                          : r.householdId
                            ? ` @ ${r.householdId}`
                            : r.paymentIntermediaryId
                              ? ` @ ${r.paymentIntermediaryId}`
                              : ""}
                    </span>
                    <span className="text-muted-foreground text-xs whitespace-nowrap">
                      {formatEnum(r.connection)}
                      {r.current && r.current !== "current"
                        ? ` (${formatEnum(r.current)})`
                        : ""}
                      {r.primaryContact ? " • primary" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">No affiliations.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Contact info</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Emails</div>
              {person.emails && person.emails.length > 0 ? (
                <ul className="space-y-1 text-sm">
                  {person.emails.map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-2">
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
              <div className="text-xs font-medium text-muted-foreground mb-1">Phone numbers</div>
              {person.phoneNumbers && person.phoneNumbers.length > 0 ? (
                <ul className="space-y-1 text-sm">
                  {person.phoneNumbers.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2">
                      <span className="truncate">{p.phoneNumber}</span>
                      <span className="text-muted-foreground text-xs">
                        {p.isPreferred ? "preferred • " : ""}
                        {formatEnum(p.validity)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">No phone numbers.</p>
              )}
            </div>
            <Separator />
            <div>
              <div className="text-xs font-medium text-muted-foreground mb-1">Addresses</div>
              {person.addresses && person.addresses.length > 0 ? (
                <ul className="space-y-2 text-sm">
                  {person.addresses.map((a) => (
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

      {(person.aboutMe || person.details || person.tags) && (
        <Card>
          <CardHeader>
            <CardTitle>Notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {person.tags && <Row label="Tags">{person.tags}</Row>}
            {person.aboutMe && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">About</div>
                <p className="whitespace-pre-wrap">{person.aboutMe}</p>
              </div>
            )}
            {person.details && (
              <div>
                <div className="text-xs font-medium text-muted-foreground mb-1">Details</div>
                <p className="whitespace-pre-wrap">{person.details}</p>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <div className="text-xs text-muted-foreground">
        Created {formatDate(person.createdAt)} • Updated {formatDate(person.updatedAt)}
      </div>
    </div>
  );
}

function NameHeader({ person }: { person: PersonDetail }) {
  const [editing, setEditing] = useState(false);
  const initial = person.fullName ?? "";
  const [value, setValue] = useState(initial);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const del = useDeletePerson({
    mutation: {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: getListPeopleQueryKey() });
        toast({ title: "Person deleted" });
        navigate("/individuals");
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
  const update = useUpdatePerson({
    mutation: {
      onSuccess: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getGetPersonQueryKey(person.id) }),
          queryClient.invalidateQueries({ queryKey: getListPeopleQueryKey() }),
        ]);
        setEditing(false);
        toast({ title: "Person updated" });
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
    const dirty = trimmed !== (person.fullName ?? "");
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="text-2xl font-serif font-bold h-12 max-w-xl"
          aria-label="Full name"
          data-testid="input-person-name"
          autoFocus
        />
        <Button
          onClick={() => {
            const body: UpdatePersonBody = { fullName: trimmed || null };
            update.mutate({ id: person.id, data: body });
          }}
          disabled={!dirty || update.isPending}
          data-testid="button-save-person-name"
        >
          {update.isPending ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setValue(initial);
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
        {personDisplayName(person)}
      </h1>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditing(true)}
          data-testid="button-edit-person-name"
        >
          Edit name
        </Button>
        <ConfirmDeleteDialog
          title={`Delete ${personDisplayName(person)}?`}
          description="This person record will be removed. Household memberships and links from opportunities or gifts may need to be cleaned up separately."
          onConfirm={() => del.mutateAsync({ id: person.id })}
          disabled={del.isPending}
          triggerTestId="button-delete-person"
          confirmTestId="button-confirm-delete-person"
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

function TagRow({ label, values }: { label: string; values?: string[] | null }) {
  if (!values || values.length === 0) return null;
  return (
    <div>
      <div className="text-xs font-medium text-muted-foreground mb-1">{label}</div>
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
