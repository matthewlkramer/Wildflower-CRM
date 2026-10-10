import { useState } from "react";
import { Link } from "wouter";
import {
  getListConferenceImportPeopleQueryKey,
  useListConferenceImportPeople,
  type ConferenceImportPerson,
  usePreviewConferenceImport,
  useStageConferenceImport,
  useConfirmConferenceImport,
  getConferenceImport,
  type ConferenceImportBatch,
  type ConferenceImportColumns,
  type ConferenceImportInput,
  type ConferenceImportConfirmInput,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EntityCombobox } from "@/components/entity-picker";
import { conferenceError } from "./type-manager";

function identityLabel(person: ConferenceImportPerson) {
  return [
    person.name,
    person.organizations.map((o) => o.name).join(" / ") ||
      "No current organization",
    person.emails.join(" / "),
    person.id,
  ]
    .filter(Boolean)
    .join(" � ");
}
function useImportPersonSearch(search: string) {
  const result = useListConferenceImportPeople({ search });
  return {
    items: (result.data ?? []).map((p) => ({
      id: p.id,
      label: identityLabel(p),
    })),
    isLoading: result.isLoading,
  };
}
function useImportPersonName(id: string | null) {
  const result = useListConferenceImportPeople(
    { personId: id ?? "" },
    {
      query: {
        queryKey: getListConferenceImportPeopleQueryKey({ personId: id ?? "" }),
        enabled: !!id,
      },
    },
  );
  return result.data?.[0] ? identityLabel(result.data[0]) : id;
}
const labels: Record<string, string> = {
  reliable: "Reliable match",
  ambiguous: "Ambiguous — choose a person",
  new_person_existing_org: "Proposed person at existing organization",
  new_foundation_person_org: "Approved foundation person / organization",
  other_unmatched: "Other unmatched — foundation status unverified",
  error: "Row error",
};
export function DocumentImport({
  eventId,
  onComplete,
}: {
  eventId: string;
  onComplete: () => void;
}) {
  const [document, setDocument] = useState<ConferenceImportInput>({
    csvText: "",
    filename: "pasted-attendees.csv",
  });
  const [columns, setColumns] = useState<ConferenceImportColumns>({ name: 0 });
  const [batch, setBatch] = useState<ConferenceImportBatch | null>(null);
  const [choices, setChoices] = useState<Record<string, "accept" | "reject">>(
    {},
  );
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [proposals, setProposals] = useState<
    NonNullable<ConferenceImportConfirmInput["newPeople"]>
  >({});
  const [error, setError] = useState("");
  const [page, setPage] = useState(0);
  const [resumeId, setResumeId] = useState("");
  const fail = (e: unknown) => setError(conferenceError(e));
  const preview = usePreviewConferenceImport({ mutation: { onError: fail } });
  const stage = useStageConferenceImport({
    mutation: {
      onSuccess: (b) => {
        setBatch(b);
        setPage(0);
        setChoices({});
        setProposals({});
        setOverrides({});
        setError("");
      },
      onError: fail,
    },
  });
  const review = useConfirmConferenceImport({
    mutation: {
      onSuccess: (b) => {
        setBatch(b);
        setChoices({});
        setError("");
        onComplete();
      },
      onError: fail,
    },
  });
  const busy = preview.isPending || stage.isPending || review.isPending;
  const changeDocument = (next: ConferenceImportInput) => {
    setDocument(next);
    preview.reset();
    setError("");
  };
  async function loadFile(file?: File) {
    if (!file) return;
    if (!/\.(csv|xlsx)$/i.test(file.name) || file.size > 2 * 1024 * 1024) {
      setError("Choose a CSV or XLSX file of 2 MiB or less.");
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      changeDocument({ fileBase64: btoa(binary), filename: file.name });
    } catch {
      setError("Could not read this file. Select it again.");
    }
  }
  const counts = batch?.rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.disposition] = (acc[r.disposition] ?? 0) + 1;
    if (r.reviewError && r.disposition === "pending")
      acc.errors = (acc.errors ?? 0) + 1;
    return acc;
  }, {});
  const selected = Object.keys(choices).filter(
    (id) => choices[id] === "accept",
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Import conference directory</CardTitle>
        <CardDescription>
          Import into the selected conference. Being listed is registration
          evidence, not proof of physical attendance. New people and
          organizations require approval.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Label htmlFor="attendee-document">CSV or XLSX (maximum 2 MiB)</Label>
        <Input
          id="attendee-document"
          type="file"
          accept=".csv,.xlsx"
          disabled={busy}
          onChange={(e) => void loadFile(e.target.files?.[0])}
        />
        <Label htmlFor="attendee-csv">Or paste CSV</Label>
        <Textarea
          id="attendee-csv"
          disabled={busy}
          value={document.csvText ?? ""}
          placeholder="Name,Organization,Title"
          onChange={(e) =>
            changeDocument({
              csvText: e.target.value,
              filename: "pasted-attendees.csv",
            })
          }
        />
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label htmlFor="header-row">Header row</Label>
            <Input
              id="header-row"
              type="number"
              min={1}
              value={document.headerRow ?? 1}
              disabled={busy}
              onChange={(e) =>
                changeDocument({
                  ...document,
                  headerRow: Number(e.target.value),
                })
              }
            />
          </div>
          <Button
            disabled={busy || (!document.csvText && !document.fileBase64)}
            onClick={() => {
              setError("");
              preview.mutate({ data: document });
            }}
          >
            Preview document
          </Button>
        </div>
        {preview.data && (
          <div className="space-y-3 rounded-md border p-3">
            <p className="text-sm">
              {document.filename}: {preview.data.rowCount} rows. Confirm the
              worksheet, header row and column mapping.
            </p>
            {preview.data.sheets.length > 1 && (
              <label className="block text-sm">
                Worksheet
                <select
                  aria-label="Worksheet"
                  className="block w-full rounded border bg-background p-2"
                  value={document.sheet ?? preview.data.sheets[0]}
                  onChange={(e) =>
                    changeDocument({ ...document, sheet: e.target.value })
                  }
                >
                  {preview.data.sheets.map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </label>
            )}
            {(
              [
                "name",
                "organization",
                "title",
                "combinedTitleOrganization",
                "email",
              ] as const
            ).map((field) => (
              <label key={field} className="block text-sm capitalize">
                {field === "combinedTitleOrganization"
                  ? "Combined title / organization"
                  : field}{" "}
                column
                <select
                  aria-label={
                    field === "combinedTitleOrganization"
                      ? "Combined title / organization column"
                      : `${field} column`
                  }
                  className="block w-full rounded border bg-background p-2"
                  value={columns[field] ?? ""}
                  onChange={(e) =>
                    setColumns((old) => {
                      const next = { ...old };
                      if (!e.target.value) delete next[field];
                      else {
                        next[field] = Number(e.target.value);
                        if (field === "combinedTitleOrganization") {
                          delete next.title;
                          delete next.organization;
                        } else if (
                          field === "title" ||
                          field === "organization"
                        )
                          delete next.combinedTitleOrganization;
                      }
                      return next;
                    })
                  }
                >
                  {field !== "name" && (
                    <option value="">Not supplied / combined text</option>
                  )}
                  {preview.data.headers.map((h, i) => (
                    <option key={i} value={i}>
                      {i + 1}: {h || "Unnamed column"}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <p className="text-xs text-muted-foreground">
              Combined lines retain their original text. Only a unique complete
              CRM organization at the end supports an automatic split; other
              boundaries require review.
            </p>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => preview.mutate({ data: { ...document, columns } })}
            >
              Preview mapped splits
            </Button>
            <div className="max-h-56 overflow-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    <th>Row</th>
                    {preview.data.headers.map((h, i) => (
                      <th key={i} className="p-2">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.data.rows.map((r) => (
                    <tr key={r.rowNumber}>
                      <td>{r.rowNumber}</td>
                      {r.cells.map((c, i) => (
                        <td key={i} className="border-t p-2">
                          {c}
                        </td>
                      ))}
                      {r.combinedText && (
                        <td className="border-t p-2">
                          Title: {r.proposedTitle || "Unresolved"};
                          organization: {r.proposedOrganization || "Unresolved"}
                          . {r.splitNeedsReview ? "Review required. " : ""}
                          {r.splitEvidence}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Button
              disabled={busy}
              onClick={() =>
                stage.mutate({ id: eventId, data: { ...document, columns } })
              }
            >
              Stage mapped rows for review
            </Button>
          </div>
        )}
        <div className="flex gap-2">
          <Input
            aria-label="Resume import ID"
            placeholder="Resume an import by ID"
            value={resumeId}
            onChange={(e) => setResumeId(e.target.value)}
          />
          <Button
            variant="outline"
            disabled={busy || !resumeId.trim()}
            onClick={() =>
              void getConferenceImport(resumeId.trim())
                .then((b) => {
                  if (b.conferenceEventId !== eventId)
                    throw new Error(
                      "This import belongs to a different conference.",
                    );
                  setBatch(b);
                  setChoices({});
                  setPage(0);
                })
                .catch(fail)
            }
          >
            Resume
          </Button>
        </div>
        {batch && (
          <div className="space-y-3">
            <p className="break-all text-xs">Import ID: {batch.id}</p>
            <p role="status" className="text-sm">
              {batch.rows.length} rows · {counts?.accept ?? 0} approved ·{" "}
              {counts?.skip ?? 0} rejected · {counts?.pending ?? 0} pending ·{" "}
              {counts?.errors ?? 0} errors
            </p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(labels).map(([category, label]) => (
                <span
                  key={category}
                  className="rounded border px-2 py-1 text-xs"
                >
                  {label}:{" "}
                  {batch.rows.filter((r) => r.category === category).length}
                </span>
              ))}
            </div>
            <Button
              variant="outline"
              disabled={busy || batch.status === "confirmed"}
              onClick={() =>
                setChoices((old) => ({
                  ...old,
                  ...Object.fromEntries(
                    batch.rows
                      .filter(
                        (r) =>
                          r.disposition === "pending" &&
                          r.category === "reliable" &&
                          !r.reviewError,
                      )
                      .map((r) => [r.id, "accept"]),
                  ),
                }))
              }
            >
              Select reliable matches
            </Button>
            {batch.rows.slice(page * 25, (page + 1) * 25).map((r) => (
              <div
                key={r.id}
                className="space-y-2 rounded-md border p-3 text-sm"
              >
                <p className="font-medium">
                  Row {r.rowNumber}: {r.rawName || "Missing name"}
                </p>
                <p>
                  {r.rawOrganization} {r.rawTitle}
                </p>
                {r.rawCombinedTitleOrganization && (
                  <div className="text-xs">
                    <p>
                      Original title / organization:{" "}
                      {r.rawCombinedTitleOrganization}
                    </p>
                    <p>
                      Split preview: {r.proposedTitle || "Unresolved title"} /{" "}
                      {r.proposedOrganization || "Unresolved organization"}.{" "}
                      {r.splitNeedsReview ? "Review required. " : ""}
                      {r.splitEvidence}
                    </p>
                  </div>
                )}
                {!!r.candidatePeople?.length && (
                  <div className="space-y-2">
                    <p className="text-xs">
                      Candidate CRM people � inspect identity and current
                      affiliation before choosing:
                    </p>
                    {r.candidatePeople.map((person) => (
                      <div
                        key={person.id}
                        className="rounded border p-2 text-xs"
                      >
                        <p>{identityLabel(person)}</p>
                        <Link
                          href={`/individuals/${person.id}`}
                          className="text-primary underline"
                        >
                          Inspect {person.name} ({person.id})
                        </Link>
                        {r.disposition === "pending" && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy}
                            onClick={() => {
                              setOverrides((old) => ({
                                ...old,
                                [r.id]: person.id,
                              }));
                              setProposals((old) => {
                                const next = { ...old };
                                delete next[r.id];
                                return next;
                              });
                            }}
                          >
                            Select {person.name} ({person.id})
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <p className="text-xs">
                  {labels[r.category ?? ""] ?? r.matchStatus} ·{" "}
                  {r.matchConfidence ?? "unassessed"} confidence ·{" "}
                  {r.disposition}
                </p>
                <p className="text-xs text-muted-foreground">
                  {r.matchEvidence}
                </p>
                {(overrides[r.id] ||
                  r.reviewedPersonId ||
                  r.matchedPersonId) && (
                  <Link
                    href={`/individuals/${overrides[r.id] || r.reviewedPersonId || r.matchedPersonId}`}
                    className="text-xs text-primary underline"
                  >
                    {overrides[r.id]
                      ? `Inspect selected CRM person (${overrides[r.id]})`
                      : r.disposition === "accept"
                        ? "View approved CRM person"
                        : `Review CRM match: ${r.matchedPersonName || r.rawName}`}
                  </Link>
                )}
                <details className="text-xs">
                  <summary>Original cells</summary>
                  <pre className="whitespace-pre-wrap break-words">
                    {JSON.stringify(
                      r.rawCells ?? [r.rawName, r.rawEmail, r.rawOrganization],
                      null,
                      2,
                    )}
                  </pre>
                </details>
                {r.reviewError && (
                  <p role="alert" className="text-xs text-destructive">
                    {r.reviewError}
                  </p>
                )}
                {r.disposition === "pending" && (
                  <>
                    <Label>Link an existing person (optional override)</Label>
                    <EntityCombobox
                      value={overrides[r.id] ?? null}
                      onChange={(id) => {
                        setOverrides((old) => ({ ...old, [r.id]: id ?? "" }));
                        setProposals((old) => {
                          const next = { ...old };
                          delete next[r.id];
                          return next;
                        });
                      }}
                      placeholder="Search existing CRM people"
                      useSearch={useImportPersonSearch}
                      useResolve={useImportPersonName}
                      allowNull
                    />
                    {r.category !== "reliable" && !overrides[r.id] && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          setProposals((old) => ({
                            ...old,
                            [r.id]: {
                              name: r.rawName ?? "",
                              organization:
                                r.rawOrganization ??
                                r.proposedOrganization ??
                                "",
                              title: r.rawTitle ?? r.proposedTitle ?? "",
                            },
                          }))
                        }
                      >
                        Prepare new-person proposal
                      </Button>
                    )}
                    {proposals[r.id] && (
                      <div className="space-y-2 rounded border bg-muted/20 p-2">
                        <p className="text-xs">
                          Proposed person{" "}
                          {r.matchedOrganizationId
                            ? "at an existing organization"
                            : "and foundation organization"}
                          . Check exact identity and affiliation.
                        </p>
                        {(["name", "organization", "title"] as const).map(
                          (field) => (
                            <label
                              key={field}
                              className="block text-xs capitalize"
                            >
                              {field}
                              <Input
                                aria-label={`Row ${r.rowNumber} ${field}`}
                                value={proposals[r.id][field] ?? ""}
                                disabled={busy}
                                onChange={(e) =>
                                  setProposals((old) => ({
                                    ...old,
                                    [r.id]: {
                                      ...old[r.id],
                                      [field]: e.target.value,
                                    },
                                  }))
                                }
                              />
                            </label>
                          ),
                        )}
                        <label className="block text-xs">
                          Foundation evidence (required when the organization is
                          new; cite a reliable source, not its name)
                          <Textarea
                            aria-label={`Row ${r.rowNumber} foundation evidence`}
                            disabled={busy}
                            value={proposals[r.id].foundationEvidence ?? ""}
                            onChange={(e) =>
                              setProposals((old) => ({
                                ...old,
                                [r.id]: {
                                  ...old[r.id],
                                  foundationEvidence:
                                    e.target.value || undefined,
                                },
                              }))
                            }
                          />
                        </label>
                      </div>
                    )}
                    <label className="mr-3 inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={choices[r.id] === "accept"}
                        onChange={(e) =>
                          setChoices((old) => {
                            const next = { ...old };
                            if (e.target.checked) next[r.id] = "accept";
                            else delete next[r.id];
                            return next;
                          })
                        }
                      />
                      Approve registration
                      {proposals[r.id] ? " and create reviewed records" : ""}
                    </label>
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={choices[r.id] === "reject"}
                        onChange={(e) =>
                          setChoices((old) => {
                            const next = { ...old };
                            if (e.target.checked) next[r.id] = "reject";
                            else delete next[r.id];
                            return next;
                          })
                        }
                      />
                      Reject / skip
                    </label>
                  </>
                )}
              </div>
            ))}
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                disabled={!page}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="text-xs">
                Page {page + 1} of{" "}
                {Math.max(1, Math.ceil(batch.rows.length / 25))}
              </span>
              <Button
                variant="ghost"
                disabled={(page + 1) * 25 >= batch.rows.length}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
            <Button
              disabled={
                busy ||
                !Object.keys(choices).length ||
                batch.status === "confirmed"
              }
              onClick={() =>
                review.mutate({
                  id: batch.id,
                  data: {
                    acceptedRowIds: selected,
                    rejectedRowIds: Object.keys(choices).filter(
                      (id) => choices[id] === "reject",
                    ),
                    personOverrides: Object.fromEntries(
                      selected
                        .filter((id) => overrides[id])
                        .map((id) => [id, overrides[id]]),
                    ),
                    newPeople: Object.fromEntries(
                      selected
                        .filter((id) => proposals[id])
                        .map((id) => [id, proposals[id]]),
                    ),
                  },
                })
              }
            >
              Apply {selected.length} approvals and{" "}
              {Object.values(choices).filter((v) => v === "reject").length}{" "}
              rejections
            </Button>
            <p className="text-xs text-muted-foreground">
              Unchecked rows remain pending. Failed rows can be corrected and
              retried. Reuploading the same mapped document resumes this review.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
