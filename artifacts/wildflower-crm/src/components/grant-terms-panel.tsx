import { useEffect, useState, type ReactNode } from "react";
import { Check, FileSearch, Plus, WalletCards } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetGrantTermsWorkspaceQueryKey,
  getGetOpportunityOrPledgeQueryKey,
  useActivateGrantTermSet,
  useAnalyzeGrantAgreement,
  useCreateManualGrantTermSet,
  useGetGrantTermsWorkspace,
  useRecordGrantSpendSnapshot,
  useRecordGrantTermOutcome,
  useReplaceGrantTermSet,
  type GrantTerm,
  type GrantTermInput,
  type GrantTermKind,
  type GrantTermOutcomeAction,
  type GrantTermSet,
  type PledgeAllocation,
  type PledgeExpectedPayment,
} from "@workspace/api-client-react";
import { RelatedCard, CardAction } from "@/components/record-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { formatCurrency, formatDate, formatEnum } from "@/lib/format";

const TERM_KINDS: Array<{ value: GrantTermKind; label: string }> = [
  { value: "donor_restriction", label: "Donor restriction" },
  { value: "condition", label: "Formal condition" },
  { value: "reporting_requirement", label: "Reporting requirement" },
  { value: "payment_requirement", label: "Payment requirement" },
  { value: "spending_rule", label: "Spending rule" },
  { value: "other_requirement", label: "Other requirement" },
];

const RESTRICTION_DIMENSIONS = [
  "entity",
  "geography",
  "purpose",
  "time",
  "project",
  "school",
] as const;

const SPENDING_RULE_TYPES = [
  "allowable_cost",
  "prohibited_cost",
  "cap",
  "prior_approval",
] as const;

type TermEditorValue = {
  mode: "manual" | "pending";
  setId?: string;
  summary: string;
  terms: GrantTermInput[];
};

function blankTerm(): GrantTermInput {
  return {
    kind: "donor_restriction",
    restrictionDimension: "purpose",
    spendingRuleType: null,
    pledgeAllocationId: null,
    expectedPaymentId: null,
    title: "",
    summary: "",
    exactQuote: null,
    sourcePage: null,
    amount: null,
    startDate: null,
    endDate: null,
    dueDate: null,
    barrier: null,
    returnOrReleaseRight: null,
    consequence: null,
    categories: null,
    capAmount: null,
    capPercent: null,
  };
}

function editableTerm(term: GrantTerm): GrantTermInput {
  return {
    pledgeAllocationId: term.pledgeAllocationId ?? null,
    expectedPaymentId: term.expectedPaymentId ?? null,
    kind: term.kind,
    restrictionDimension: term.restrictionDimension ?? null,
    spendingRuleType: term.spendingRuleType ?? null,
    title: term.title,
    summary: term.summary,
    exactQuote: term.exactQuote ?? null,
    sourcePage: term.sourcePage ?? null,
    amount: term.amount ?? null,
    startDate: term.startDate ?? null,
    endDate: term.endDate ?? null,
    dueDate: term.dueDate ?? null,
    barrier: term.barrier ?? null,
    returnOrReleaseRight: term.returnOrReleaseRight ?? null,
    consequence: term.consequence ?? null,
    categories: term.categories ?? null,
    capAmount: term.capAmount ?? null,
    capPercent: term.capPercent ?? null,
  };
}

export function GrantTermsPanel({
  opportunityId,
  grantLetterUrl,
  grantLetterFilename,
  allocations,
  expectedPayments,
}: {
  opportunityId: string;
  grantLetterUrl: string | null;
  grantLetterFilename: string | null;
  allocations: PledgeAllocation[];
  expectedPayments: PledgeExpectedPayment[];
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const workspace = useGetGrantTermsWorkspace(opportunityId);
  const [editor, setEditor] = useState<TermEditorValue | null>(null);
  const [outcomeTerm, setOutcomeTerm] = useState<GrantTerm | null>(null);
  const [spendAllocationId, setSpendAllocationId] = useState<string | null>(
    null,
  );

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: getGetGrantTermsWorkspaceQueryKey(opportunityId),
      }),
      queryClient.invalidateQueries({
        queryKey: getGetOpportunityOrPledgeQueryKey(opportunityId),
      }),
    ]);
  };

  const manual = useCreateManualGrantTermSet({
    mutation: {
      onSuccess: async () => {
        setEditor(null);
        await refresh();
        toast({ title: "Provisional grant terms saved" });
      },
      onError: (error: unknown) =>
        failureToast(toast, "Could not save terms", error),
    },
  });
  const replace = useReplaceGrantTermSet({
    mutation: {
      onSuccess: async () => {
        setEditor(null);
        await refresh();
        toast({ title: "Grant review revised" });
      },
      onError: (error: unknown) =>
        failureToast(toast, "Could not revise review", error),
    },
  });
  const activate = useActivateGrantTermSet({
    mutation: {
      onSuccess: async () => {
        await refresh();
        toast({
          title: "Grant terms accepted",
          description:
            "The reviewed restrictions and conditions now govern the allocations.",
        });
      },
      onError: (error: unknown) =>
        failureToast(toast, "Could not accept review", error),
    },
  });
  const analyze = useAnalyzeGrantAgreement({
    mutation: {
      onSuccess: async () => {
        await refresh();
        toast({ title: "Grant agreement review ready" });
      },
      onError: (error: unknown) =>
        failureToast(toast, "Could not analyze agreement", error),
    },
  });

  const sets = workspace.data?.termSets ?? [];
  const active = sets.find((set) => set.status === "active");
  const pending = sets.find((set) => set.status === "pending_review");
  const visibleTerms = pending?.terms ?? active?.terms ?? [];
  const statusLabel = pending
    ? "Review needed"
    : active?.source === "manual"
      ? "Provisional"
      : active
        ? "Accepted"
        : "Not reviewed";

  const openManualEditor = (seed?: GrantTermSet) =>
    setEditor({
      mode: "manual",
      summary: seed?.analysisSummary ?? "",
      terms: seed?.terms.map(editableTerm) ?? [blankTerm()],
    });
  const openPendingEditor = (set: GrantTermSet) =>
    setEditor({
      mode: "pending",
      setId: set.id,
      summary: set.analysisSummary ?? "",
      terms: set.terms.map(editableTerm),
    });

  return (
    <>
      <RelatedCard
        title="Grant terms"
        count={visibleTerms.length || undefined}
        empty={false}
        action={
          !active && !pending ? (
            <CardAction label="Add" onClick={() => openManualEditor()} />
          ) : undefined
        }
      >
        <div className="space-y-3 px-1 py-1 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={pending ? "destructive" : "secondary"}>
              {statusLabel}
            </Badge>
            <Badge variant={workspace.data?.restricted ? "default" : "outline"}>
              {workspace.data?.restricted == null
                ? "Restriction not determined"
                : workspace.data.restricted
                  ? "Restricted"
                  : "Unrestricted"}
            </Badge>
          </div>

          {workspace.data?.restrictionBasis?.length ? (
            <p className="text-xs text-muted-foreground">
              {workspace.data.restrictionBasis.join(" · ")}
            </p>
          ) : null}

          {pending ? (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-950">
              <div className="font-medium">
                AI proposal awaiting human review
              </div>
              {pending.analysisSummary ? (
                <p className="mt-1 text-xs">{pending.analysisSummary}</p>
              ) : null}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => openPendingEditor(pending)}
                >
                  Revise proposal
                </Button>
                <Button
                  size="sm"
                  disabled={activate.isPending}
                  onClick={() => activate.mutate({ id: pending.id })}
                >
                  <Check className="mr-1.5 h-4 w-4" />
                  Accept terms
                </Button>
              </div>
            </div>
          ) : null}

          {!pending && active?.source === "manual" ? (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() => openManualEditor(active)}
              >
                Edit provisional terms
              </Button>
            </div>
          ) : null}

          {grantLetterUrl && grantLetterFilename ? (
            <Button
              className="w-full"
              size="sm"
              variant="outline"
              disabled={analyze.isPending}
              onClick={() =>
                analyze.mutate({
                  id: opportunityId,
                  data: {
                    documentUrl: grantLetterUrl,
                    documentFilename: grantLetterFilename,
                    source: "grant_agreement",
                  },
                })
              }
            >
              <FileSearch className="mr-1.5 h-4 w-4" />
              {analyze.isPending
                ? "Analyzing agreement…"
                : pending
                  ? "Analyze agreement again"
                  : "Analyze grant agreement"}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              Upload a grant letter to generate a proposed list of restrictions
              and conditions.
            </p>
          )}

          {visibleTerms.length ? (
            <div className="space-y-2 border-t pt-3">
              {visibleTerms.map((term) => (
                <TermSummary
                  key={term.id}
                  term={term}
                  allocations={allocations}
                  expectedPayments={expectedPayments}
                  editableOutcome={!pending && active?.id === term.termSetId}
                  onOutcome={() => setOutcomeTerm(term)}
                />
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No restrictions or conditions have been entered yet.
            </p>
          )}

          {workspace.data?.allocationSpending.length ? (
            <div className="space-y-2 border-t pt-3">
              <div className="flex items-center gap-1.5 font-medium">
                <WalletCards className="h-4 w-4" /> Spending progress
              </div>
              <p className="text-xs text-muted-foreground">
                Manual cumulative checkpoints only; these are not QuickBooks
                expenses.
              </p>
              {workspace.data.allocationSpending.map((spending) => {
                const allocation = allocations.find(
                  (candidate) => candidate.id === spending.pledgeAllocationId,
                );
                return (
                  <div
                    key={spending.pledgeAllocationId}
                    className="rounded-lg border p-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-medium">
                          {allocationLabel(allocation, allocations)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatCurrency(spending.amountSpentToDate)} spent
                          {spending.allocationAmount
                            ? ` of ${formatCurrency(spending.allocationAmount)}`
                            : ""}
                          {spending.latestAsOfDate
                            ? ` as of ${formatDate(spending.latestAsOfDate)}`
                            : ""}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setSpendAllocationId(spending.pledgeAllocationId)
                        }
                      >
                        Update
                      </Button>
                    </div>
                    {spending.latestNote ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {spending.latestNote}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      </RelatedCard>

      <TermSetEditor
        value={editor}
        allocations={allocations}
        expectedPayments={expectedPayments}
        busy={manual.isPending || replace.isPending}
        onChange={setEditor}
        onClose={() => setEditor(null)}
        onSave={(value) => {
          const data = {
            analysisSummary: value.summary.trim() || null,
            terms: value.terms,
          };
          if (value.mode === "pending" && value.setId) {
            replace.mutate({ id: value.setId, data });
          } else {
            manual.mutate({ id: opportunityId, data });
          }
        }}
      />
      <OutcomeDialog
        term={outcomeTerm}
        opportunityId={opportunityId}
        onClose={() => setOutcomeTerm(null)}
      />
      <SpendDialog
        allocationId={spendAllocationId}
        opportunityId={opportunityId}
        currentAmount={
          workspace.data?.allocationSpending.find(
            (item) => item.pledgeAllocationId === spendAllocationId,
          )?.amountSpentToDate ?? "0.00"
        }
        onClose={() => setSpendAllocationId(null)}
      />
    </>
  );
}

function TermSummary({
  term,
  allocations,
  expectedPayments,
  editableOutcome,
  onOutcome,
}: {
  term: GrantTerm;
  allocations: PledgeAllocation[];
  expectedPayments: PledgeExpectedPayment[];
  editableOutcome: boolean;
  onOutcome: () => void;
}) {
  return (
    <div
      className="rounded-lg border p-2.5"
      data-testid={`grant-term-${term.id}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">{formatEnum(term.kind)}</Badge>
        {term.restrictionDimension ? (
          <Badge variant="secondary">
            {formatEnum(term.restrictionDimension)}
          </Badge>
        ) : null}
        {term.spendingRuleType ? (
          <Badge variant="secondary">{formatEnum(term.spendingRuleType)}</Badge>
        ) : null}
        {term.pledgeAllocationId ? (
          <Badge variant="outline">
            {allocationLabel(
              allocations.find(
                (allocation) => allocation.id === term.pledgeAllocationId,
              ),
              allocations,
            )}
          </Badge>
        ) : null}
        {term.expectedPaymentId ? (
          <Badge variant="outline">
            {paymentLabel(
              expectedPayments.find(
                (payment) => payment.id === term.expectedPaymentId,
              ),
            )}
          </Badge>
        ) : null}
        {(term.kind === "condition" || term.kind === "donor_restriction") &&
        term.currentOutcome !== "pending" ? (
          <Badge variant="secondary">{formatEnum(term.currentOutcome)}</Badge>
        ) : null}
        {term.overdue ? <Badge variant="destructive">Overdue</Badge> : null}
      </div>
      <div className="mt-1.5 font-medium">{term.title}</div>
      <p className="mt-0.5 text-xs text-muted-foreground">{term.summary}</p>
      {term.kind === "condition" ? (
        <div className="mt-2 space-y-1 rounded-md bg-muted/50 p-2 text-xs">
          <p>
            <span className="font-medium">Barrier:</span> {term.barrier}
          </p>
          <p>
            <span className="font-medium">Return/release right:</span>{" "}
            {term.returnOrReleaseRight}
          </p>
          {term.consequence ? (
            <p>
              <span className="font-medium">Consequence:</span>{" "}
              {term.consequence}
            </p>
          ) : null}
        </div>
      ) : null}
      {term.kind === "spending_rule" &&
      (term.categories?.length || term.capAmount || term.capPercent) ? (
        <div className="mt-2 space-y-1 rounded-md bg-muted/50 p-2 text-xs">
          {term.categories?.length ? (
            <p>
              <span className="font-medium">Cost categories:</span>{" "}
              {term.categories.join(", ")}
            </p>
          ) : null}
          {term.capAmount ? (
            <p>
              <span className="font-medium">Cap:</span>{" "}
              {formatCurrency(term.capAmount)}
            </p>
          ) : null}
          {term.capPercent ? (
            <p>
              <span className="font-medium">Cap:</span>{" "}
              {formatPercent(term.capPercent)}
            </p>
          ) : null}
        </div>
      ) : null}
      {term.exactQuote ? (
        <blockquote className="mt-2 border-l-2 pl-2 text-xs italic text-muted-foreground">
          “{term.exactQuote}”{term.sourcePage ? ` — ${term.sourcePage}` : ""}
        </blockquote>
      ) : null}
      {editableOutcome &&
      (term.kind === "condition" || term.kind === "donor_restriction") ? (
        <Button className="mt-2" size="sm" variant="ghost" onClick={onOutcome}>
          Update status
        </Button>
      ) : null}
    </div>
  );
}

function TermSetEditor({
  value,
  allocations,
  expectedPayments,
  busy,
  onChange,
  onClose,
  onSave,
}: {
  value: TermEditorValue | null;
  allocations: PledgeAllocation[];
  expectedPayments: PledgeExpectedPayment[];
  busy: boolean;
  onChange: (value: TermEditorValue | null) => void;
  onClose: () => void;
  onSave: (value: TermEditorValue) => void;
}) {
  const updateTerm = (index: number, patch: Partial<GrantTermInput>) => {
    if (!value) return;
    const terms = value.terms.map((term, i) =>
      i === index ? { ...term, ...patch } : term,
    );
    onChange({ ...value, terms });
  };
  const canSave =
    !!value &&
    (value.mode === "pending" || value.terms.length > 0) &&
    value.terms.every(
      (term) =>
        term.title.trim() &&
        term.summary.trim() &&
        (term.kind !== "donor_restriction" || term.restrictionDimension) &&
        (term.kind !== "condition" ||
          (term.barrier?.trim() && term.returnOrReleaseRight?.trim())) &&
        (term.kind !== "spending_rule" || term.spendingRuleType),
    );

  return (
    <Dialog open={!!value} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {value?.mode === "pending"
              ? "Revise grant agreement proposal"
              : "Enter provisional grant terms"}
          </DialogTitle>
          <DialogDescription>
            Restrictions and formal conditions update allocation coding only
            after you save or accept them. A formal condition must include both
            a substantive barrier and a return or release right.
          </DialogDescription>
        </DialogHeader>
        {value ? (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Overall note</Label>
              <Textarea
                value={value.summary}
                onChange={(event) =>
                  onChange({ ...value, summary: event.target.value })
                }
                placeholder="Optional context for the reviewer"
              />
            </div>
            {value.terms.map((term, index) => (
              <div key={index} className="space-y-3 rounded-xl border p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium">Term {index + 1}</div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      onChange({
                        ...value,
                        terms: value.terms.filter(
                          (_, candidate) => candidate !== index,
                        ),
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Type">
                    <Select
                      value={term.kind}
                      onValueChange={(next) =>
                        updateTerm(index, { kind: next as GrantTermKind })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TERM_KINDS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field label="Allocation scope">
                    <Select
                      value={term.pledgeAllocationId ?? "all"}
                      onValueChange={(next) =>
                        updateTerm(index, {
                          pledgeAllocationId: next === "all" ? null : next,
                        })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All allocations</SelectItem>
                        {allocations.map((allocation) => (
                          <SelectItem key={allocation.id} value={allocation.id}>
                            {allocationLabel(allocation, allocations)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  {expectedPayments.length ? (
                    <Field label="Payment scope">
                      <Select
                        value={term.expectedPaymentId ?? "all"}
                        onValueChange={(next) =>
                          updateTerm(index, {
                            expectedPaymentId: next === "all" ? null : next,
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All payments</SelectItem>
                          {expectedPayments.map((payment) => (
                            <SelectItem key={payment.id} value={payment.id}>
                              {paymentLabel(payment)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  ) : null}
                  {term.kind === "donor_restriction" ? (
                    <Field label="Restriction dimension">
                      <Select
                        value={term.restrictionDimension ?? "purpose"}
                        onValueChange={(next) =>
                          updateTerm(index, {
                            restrictionDimension:
                              next as GrantTermInput["restrictionDimension"],
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {RESTRICTION_DIMENSIONS.map((dimension) => (
                            <SelectItem key={dimension} value={dimension}>
                              {formatEnum(dimension)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  ) : null}
                  {term.kind === "spending_rule" ? (
                    <Field label="Spending rule type">
                      <Select
                        value={term.spendingRuleType ?? "allowable_cost"}
                        onValueChange={(next) =>
                          updateTerm(index, {
                            spendingRuleType:
                              next as GrantTermInput["spendingRuleType"],
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SPENDING_RULE_TYPES.map((rule) => (
                            <SelectItem key={rule} value={rule}>
                              {formatEnum(rule)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  ) : null}
                </div>
                <Field label="Title">
                  <Input
                    value={term.title}
                    onChange={(event) =>
                      updateTerm(index, { title: event.target.value })
                    }
                  />
                </Field>
                <Field label="Plain-language summary">
                  <Textarea
                    value={term.summary}
                    onChange={(event) =>
                      updateTerm(index, { summary: event.target.value })
                    }
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
                  <Field label="Verbatim supporting text">
                    <Textarea
                      value={term.exactQuote ?? ""}
                      onChange={(event) =>
                        updateTerm(index, {
                          exactQuote: event.target.value || null,
                        })
                      }
                      placeholder="Exact words from the agreement"
                    />
                  </Field>
                  <Field label="Page">
                    <Input
                      value={term.sourcePage ?? ""}
                      onChange={(event) =>
                        updateTerm(index, {
                          sourcePage: event.target.value || null,
                        })
                      }
                    />
                  </Field>
                </div>
                {term.kind === "condition" ? (
                  <div className="space-y-3">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <Field label="Substantive barrier">
                        <Textarea
                          value={term.barrier ?? ""}
                          onChange={(event) =>
                            updateTerm(index, {
                              barrier: event.target.value || null,
                            })
                          }
                        />
                      </Field>
                      <Field label="Return or release right">
                        <Textarea
                          value={term.returnOrReleaseRight ?? ""}
                          onChange={(event) =>
                            updateTerm(index, {
                              returnOrReleaseRight: event.target.value || null,
                            })
                          }
                        />
                      </Field>
                    </div>
                    <Field label="Consequence if not met (optional)">
                      <Textarea
                        value={term.consequence ?? ""}
                        onChange={(event) =>
                          updateTerm(index, {
                            consequence: event.target.value || null,
                          })
                        }
                      />
                    </Field>
                  </div>
                ) : null}
                {term.kind === "spending_rule" ? (
                  <div className="space-y-3">
                    <Field label="Allowable or prohibited cost categories">
                      <Input
                        value={term.categories?.join(", ") ?? ""}
                        onChange={(event) =>
                          updateTerm(index, {
                            categories: event.target.value
                              ? event.target.value
                                  .split(",")
                                  .map((category) => category.trim())
                                  .filter(Boolean)
                              : null,
                          })
                        }
                        placeholder="e.g. teacher salaries, materials, travel"
                      />
                    </Field>
                    {term.spendingRuleType === "cap" ? (
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Cap amount">
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            value={term.capAmount ?? ""}
                            onChange={(event) =>
                              updateTerm(index, {
                                capAmount: event.target.value || null,
                              })
                            }
                          />
                        </Field>
                        <Field label="Cap percentage">
                          <Input
                            type="number"
                            min="0"
                            max="100"
                            step="0.01"
                            value={percentInput(term.capPercent)}
                            onChange={(event) =>
                              updateTerm(index, {
                                capPercent: event.target.value
                                  ? String(Number(event.target.value) / 100)
                                  : null,
                              })
                            }
                            placeholder="0–100"
                          />
                        </Field>
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label="Start date">
                    <Input
                      type="date"
                      value={term.startDate ?? ""}
                      onChange={(event) =>
                        updateTerm(index, {
                          startDate: event.target.value || null,
                        })
                      }
                    />
                  </Field>
                  <Field label="End date">
                    <Input
                      type="date"
                      value={term.endDate ?? ""}
                      onChange={(event) =>
                        updateTerm(index, {
                          endDate: event.target.value || null,
                        })
                      }
                    />
                  </Field>
                  <Field label="Due date">
                    <Input
                      type="date"
                      value={term.dueDate ?? ""}
                      onChange={(event) =>
                        updateTerm(index, {
                          dueDate: event.target.value || null,
                        })
                      }
                    />
                  </Field>
                </div>
              </div>
            ))}
            <Button
              variant="outline"
              onClick={() =>
                onChange({ ...value, terms: [...value.terms, blankTerm()] })
              }
            >
              <Plus className="mr-1.5 h-4 w-4" /> Add term
            </Button>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!canSave || busy}
            onClick={() => value && onSave(value)}
          >
            {busy
              ? "Saving…"
              : value?.mode === "pending"
                ? "Save proposal"
                : "Save provisional terms"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function OutcomeDialog({
  term,
  opportunityId,
  onClose,
}: {
  term: GrantTerm | null;
  opportunityId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [outcome, setOutcome] = useState<GrantTermOutcomeAction>("satisfied");
  const [effectiveDate, setEffectiveDate] = useState(todayInput());
  const [note, setNote] = useState("");
  const record = useRecordGrantTermOutcome({
    mutation: {
      onSuccess: async () => {
        onClose();
        setNote("");
        await queryClient.invalidateQueries({
          queryKey: getGetGrantTermsWorkspaceQueryKey(opportunityId),
        });
        toast({ title: "Term status updated" });
      },
      onError: (error: unknown) =>
        failureToast(toast, "Could not update status", error),
    },
  });
  return (
    <Dialog open={!!term} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Update term status</DialogTitle>
          <DialogDescription>{term?.title}</DialogDescription>
        </DialogHeader>
        <Field label="Outcome">
          <Select
            value={outcome}
            onValueChange={(next) => setOutcome(next as GrantTermOutcomeAction)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="satisfied">Satisfied</SelectItem>
              {term?.kind === "condition" ? (
                <SelectItem value="missed">Missed</SelectItem>
              ) : null}
              <SelectItem value="waived">Waived</SelectItem>
              <SelectItem value="reopened">Reopen / pending</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Effective date">
          <Input
            type="date"
            value={effectiveDate}
            onChange={(event) => setEffectiveDate(event.target.value)}
          />
        </Field>
        <Field label="Note">
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!term || !effectiveDate || record.isPending}
            onClick={() =>
              term &&
              record.mutate({
                id: term.id,
                data: { outcome, effectiveDate, note: note.trim() || null },
              })
            }
          >
            Save status
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SpendDialog({
  allocationId,
  opportunityId,
  currentAmount,
  onClose,
}: {
  allocationId: string | null;
  opportunityId: string;
  currentAmount: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [amount, setAmount] = useState(currentAmount);
  const [asOfDate, setAsOfDate] = useState(todayInput());
  const [note, setNote] = useState("");
  useEffect(() => {
    if (allocationId) setAmount(currentAmount);
  }, [allocationId, currentAmount]);
  const effectiveAmount = allocationId ? amount : currentAmount;
  const record = useRecordGrantSpendSnapshot({
    mutation: {
      onSuccess: async () => {
        onClose();
        setNote("");
        await queryClient.invalidateQueries({
          queryKey: getGetGrantTermsWorkspaceQueryKey(opportunityId),
        });
        toast({ title: "Spending progress recorded" });
      },
      onError: (error: unknown) =>
        failureToast(toast, "Could not record spending", error),
    },
  });
  return (
    <Dialog
      open={!!allocationId}
      onOpenChange={(open) => {
        if (open) setAmount(currentAmount);
        else onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record cumulative spending</DialogTitle>
          <DialogDescription>
            Enter the total spent against this allocation as of the selected
            date. This does not create or reconcile expenses.
          </DialogDescription>
        </DialogHeader>
        <Field label="Amount spent to date">
          <Input
            inputMode="decimal"
            value={effectiveAmount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <Field label="As of date">
          <Input
            type="date"
            value={asOfDate}
            onChange={(event) => setAsOfDate(event.target.value)}
          />
        </Field>
        <Field label="Note">
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={
              !allocationId ||
              !/^\d+(\.\d{1,2})?$/.test(effectiveAmount) ||
              !asOfDate ||
              record.isPending
            }
            onClick={() =>
              allocationId &&
              record.mutate({
                id: allocationId,
                data: {
                  amountSpentToDate: effectiveAmount,
                  asOfDate,
                  note: note.trim() || null,
                },
              })
            }
          >
            Save checkpoint
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function allocationLabel(
  allocation: PledgeAllocation | undefined,
  allocations: PledgeAllocation[],
) {
  if (!allocation) return "Grant allocation";
  const index = allocations.findIndex(
    (candidate) => candidate.id === allocation.id,
  );
  const parts = [
    `Allocation ${index + 1}`,
    allocation.grantYear?.toUpperCase(),
    allocation.subAmount ? formatCurrency(allocation.subAmount) : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function paymentLabel(payment: PledgeExpectedPayment | undefined) {
  if (!payment) return "Scheduled payment";
  return [
    formatDate(payment.expectedDate),
    payment.amount ? formatCurrency(payment.amount) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function todayInput() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/Chicago",
  });
}

function percentInput(decimal: string | null | undefined) {
  if (!decimal) return "";
  const value = Number(decimal);
  return Number.isFinite(value) ? String(value * 100) : "";
}

function formatPercent(decimal: string) {
  const value = Number(decimal);
  return Number.isFinite(value) ? `${value * 100}%` : decimal;
}

function failureToast(
  toast: ReturnType<typeof useToast>["toast"],
  title: string,
  error: unknown,
) {
  toast({
    title,
    description: error instanceof Error ? error.message : String(error),
    variant: "destructive",
  });
}
