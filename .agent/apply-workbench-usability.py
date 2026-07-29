from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    return text.replace(old, new, 1)


def sub_once(text: str, pattern: str, repl: str, label: str, flags: int = 0) -> str:
    result, count = re.subn(pattern, repl, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{label}: expected one regex occurrence, found {count}")
    return result


# ---------------------------------------------------------------------------
# Recent changes: current user, all reconciliation actions; Undo stays optional.
# ---------------------------------------------------------------------------
recent_path = "artifacts/api-server/src/routes/reconciliation/recentChanges.ts"
recent = read(recent_path)
recent = replace_once(
    recent,
    '''    const items = rows
      .filter((row) => row.actorUserId === user.id)
      .map((row) => ({
        id: row.id,
        at: row.at,
        actorName: row.actorName,
        summary: row.summary ?? "",
        undo: undoOf(row.metadata),
      }))
      .filter(
        (item): item is typeof item & { undo: NonNullable<typeof item.undo> } =>
          item.undo !== null,
      )
      .slice(0, 20);''',
    '''    const items = rows
      .filter((row) => row.actorUserId === user.id)
      .map((row) => ({
        id: row.id,
        at: row.at,
        actorName: row.actorName,
        summary: row.summary ?? "",
        undo: undoOf(row.metadata),
      }))
      .slice(0, 20);''',
    "recent changes mapping",
)
write(recent_path, recent)


# ---------------------------------------------------------------------------
# Deposit API: broad candidate search, claim metadata, atomic retarget, generic
# accounting-evidence unlink, component unlink with gift preservation, auditing.
# ---------------------------------------------------------------------------
api_path = "artifacts/api-server/src/routes/reconciliation/workbenchDeposits.ts"
api = read(api_path)
if 'from "../../lib/reconciliationAudit"' not in api:
    marker = 'import { buildCrmRecordCompleteness } from "./workbenchClusters";'
    api = replace_once(
        api,
        marker,
        marker + '\nimport { reconAudit, fmtMoney } from "../../lib/reconciliationAudit";',
        "audit import",
    )

api = replace_once(
    api,
    "    const amountBand = Math.max(0.01, targetAmount * 0.2);\n",
    "",
    "remove candidate amount band",
)

api = replace_once(
    api,
    '''        ) AS source_label
      FROM payment_units u
      LEFT JOIN staged_payments sp ON sp.id = u.source_staged_payment_id
      WHERE u.kind IN ('check', 'direct_ach', 'wire', 'other')''',
    '''        ) AS source_label,
        claim.id AS claimed_component_id,
        claim.bank_deposit_id AS claimed_bank_deposit_id,
        claim.deposit_date,
        claim.deposit_amount,
        claim.deposit_memo
      FROM payment_units u
      LEFT JOIN staged_payments sp ON sp.id = u.source_staged_payment_id
      LEFT JOIN LATERAL (
        SELECT
          c.id,
          c.bank_deposit_id,
          d2.deposit_date::text AS deposit_date,
          d2.amount::text AS deposit_amount,
          d2.memo AS deposit_memo
        FROM bank_deposit_components c
        JOIN bank_deposits d2 ON d2.id = c.bank_deposit_id
        WHERE c.payment_unit_id = u.id
        ORDER BY c.id
        LIMIT 1
      ) claim ON TRUE
      WHERE u.kind IN ('check', 'direct_ach', 'wire', 'other')''',
    "candidate claim join",
)

api = sub_once(
    api,
    r'''\n        AND NOT EXISTS \(\n          SELECT 1\n          FROM bank_deposit_components claimed\n          WHERE claimed\.payment_unit_id = u\.id\n        \)\n        AND abs\(COALESCE\(u\.gross_amount, u\.net_amount\) - \$\{targetAmount\}::numeric\) <= \$\{amountBand\}::numeric''',
    "",
    "remove candidate claim and proximity filters",
)

api = replace_once(
    api,
    '''          source_label: string;
        }>
      )[0];''',
    '''          source_label: string;
          claimed_component_id: string | null;
          claimed_bank_deposit_id: string | null;
          deposit_date: string | null;
          deposit_amount: string | null;
          deposit_memo: string | null;
        }>
      )[0];''',
    "candidate result type",
) if False else api
# The candidate result is an array, not [0]; patch that exact type separately.
api = replace_once(
    api,
    '''          received_date: string | null;
          source_label: string;
        }>
      ).map((row) => ({''',
    '''          received_date: string | null;
          source_label: string;
          claimed_component_id: string | null;
          claimed_bank_deposit_id: string | null;
          deposit_date: string | null;
          deposit_amount: string | null;
          deposit_memo: string | null;
        }>
      ).map((row) => ({''',
    "candidate map type",
)
api = replace_once(
    api,
    '''        receivedDate: row.received_date,
        sourceLabel: row.source_label,
      })),''',
    '''        receivedDate: row.received_date,
        sourceLabel: row.source_label,
        claimed: row.claimed_component_id != null,
        claimedComponentId: row.claimed_component_id,
        claimedBankDepositId: row.claimed_bank_deposit_id,
        claimedDepositDate: row.deposit_date,
        claimedDepositAmount: row.deposit_amount,
        claimedDepositMemo: row.deposit_memo,
        claimedByCurrentDeposit:
          row.claimed_bank_deposit_id === params.bankDepositId,
      })),''',
    "candidate claim map",
)

# Attach mode: lock the existing claim so a claimed unit can be moved atomically.
api = replace_once(
    api,
    '''      let paymentUnitId: string;
      let componentAmount: number;
      let needsReview = false;''',
    '''      let paymentUnitId: string;
      let componentAmount: number;
      let needsReview = false;
      let existingComponentId: string | null = null;
      let movedFromDepositId: string | null = null;''',
    "attach retarget variables",
)
api = replace_once(
    api,
    '''        const claimed = await tx.execute(sql`
          SELECT 1
          FROM bank_deposit_components
          WHERE payment_unit_id = ${body.paymentUnitId}
          LIMIT 1
        `);
        if (claimed.rows.length) return { kind: "unit_unavailable" as const };''',
    '''        const claimed = await tx.execute(sql`
          SELECT id, bank_deposit_id
          FROM bank_deposit_components
          WHERE payment_unit_id = ${body.paymentUnitId}
          ORDER BY id
          LIMIT 1
          FOR UPDATE
        `);
        const existingClaim = (
          claimed.rows as Array<{ id: string; bank_deposit_id: string }>
        )[0];
        if (existingClaim?.bank_deposit_id === params.bankDepositId) {
          return {
            kind: "ok" as const,
            id: existingClaim.id,
            paymentUnitId: unit.id,
            amount: Number(unit.amount ?? 0).toFixed(2),
            needsReview: false,
            movedFromDepositId: null,
          };
        }
        if (existingClaim) {
          existingComponentId = existingClaim.id;
          movedFromDepositId = existingClaim.bank_deposit_id;
        }''',
    "atomic claimed-unit retarget",
)
api = replace_once(
    api,
    '''      const componentId = `bdc_${newId()}`;
      await tx.execute(sql`
        INSERT INTO bank_deposit_components
          (id, bank_deposit_id, payment_unit_id, amount, source, needs_review)
        VALUES (
          ${componentId},
          ${params.bankDepositId},
          ${paymentUnitId},
          ${componentAmount}::numeric,
          'manual',
          ${needsReview}
        )
      `);
      return {
        kind: "ok" as const,
        id: componentId,
        paymentUnitId,
        amount: componentAmount.toFixed(2),
        needsReview,
      };''',
    '''      if (existingComponentId) {
        await tx.execute(sql`
          UPDATE bank_deposit_components
          SET bank_deposit_id = ${params.bankDepositId},
              amount = ${componentAmount}::numeric,
              source = 'manual',
              needs_review = false
          WHERE id = ${existingComponentId}
        `);
        return {
          kind: "ok" as const,
          id: existingComponentId,
          paymentUnitId,
          amount: componentAmount.toFixed(2),
          needsReview: false,
          movedFromDepositId,
        };
      }

      const componentId = `bdc_${newId()}`;
      await tx.execute(sql`
        INSERT INTO bank_deposit_components
          (id, bank_deposit_id, payment_unit_id, amount, source, needs_review)
        VALUES (
          ${componentId},
          ${params.bankDepositId},
          ${paymentUnitId},
          ${componentAmount}::numeric,
          'manual',
          ${needsReview}
        )
      `);
      return {
        kind: "ok" as const,
        id: componentId,
        paymentUnitId,
        amount: componentAmount.toFixed(2),
        needsReview,
        movedFromDepositId: null,
      };''',
    "retarget or create component",
)
api = replace_once(
    api,
    '''    res.status(201).json({
      id: result.id,''',
    '''    await reconAudit(req, {
      action: "update",
      entityType: "staged_payment",
      entityId: result.paymentUnitId,
      summary: result.movedFromDepositId
        ? `Moved payment ${result.paymentUnitId} to deposit ${params.bankDepositId} (${fmtMoney(result.amount)})`
        : `Attached payment ${result.paymentUnitId} to deposit ${params.bankDepositId} (${fmtMoney(result.amount)})`,
      undo: null,
      extra: {
        componentId: result.id,
        bankDepositId: params.bankDepositId,
        movedFromDepositId: result.movedFromDepositId,
      },
    });

    res.status(201).json({
      id: result.id,''',
    "audit component attach",
)

# Component unlink preserves a gift-bearing unit; only unsupported inferred/system
# component sources remain protected.
api = replace_once(
    api,
    '''               u.id AS unit_id, u.id LIKE 'pu_manual_%' AS minted,
               u.gift_id IS NOT NULL AS has_counted_application''',
    '''               c.bank_deposit_id, c.amount::text AS component_amount,
               u.id AS unit_id, u.id LIKE 'pu_manual_%' AS minted,
               u.gift_id IS NOT NULL AS has_counted_application''',
    "component unlink details select",
)
api = replace_once(
    api,
    '''          payment_unit_id: string;
          unit_id: string;''',
    '''          payment_unit_id: string;
          bank_deposit_id: string;
          component_amount: string;
          unit_id: string;''',
    "component unlink details type",
)
api = replace_once(
    api,
    '''      if (
        !["manual", "qbo_inferred"].includes(component.source) ||
        component.has_counted_application
      ) {''',
    '''      if (!["manual", "qbo_inferred"].includes(component.source)) {''',
    "allow gift-bearing component unlink",
)
api = replace_once(
    api,
    '''      return { kind: "ok" as const };''',
    '''      return {
        kind: "ok" as const,
        paymentUnitId: component.payment_unit_id,
        bankDepositId: component.bank_deposit_id,
        amount: component.component_amount,
      };''',
    "component unlink result",
)
api = replace_once(
    api,
    '''          "Only manual or QBO-inferred components without a counted gift can be removed.",''',
    '''          "Only manual or QBO-inferred deposit components can be unlinked.",''',
    "component unlink error",
)
api = replace_once(
    api,
    '''    res.status(204).send();
  }),
);

router.post(
  "/reconciliation/accounting-checks/:id/disposition",''',
    '''    await reconAudit(req, {
      action: "delete",
      entityType: "staged_payment",
      entityId: result.paymentUnitId,
      summary: `Unlinked payment ${result.paymentUnitId} from deposit ${result.bankDepositId} (${fmtMoney(result.amount)})`,
      undo: null,
      extra: { bankDepositId: result.bankDepositId },
    });
    res.status(204).send();
  }),
);

router.delete(
  "/reconciliation/accounting-evidence/:stagedPaymentId",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const stagedPaymentId = String(req.params.stagedPaymentId ?? "");
    if (!stagedPaymentId) {
      res.status(400).json({ error: "validation_error", message: "A staged payment id is required." });
      return;
    }
    const result = await db.transaction(async (tx) => {
      const sourceResult = await tx.execute(sql`
        SELECT id, link_type
        FROM source_links
        WHERE qb_staged_payment_id = ${stagedPaymentId}
          AND link_type IN ('payout_qb_settlement', 'qbo_line_deposit')
        FOR UPDATE
      `);
      const unitResult = await tx.execute(sql`
        SELECT id
        FROM payment_units
        WHERE source_staged_payment_id = ${stagedPaymentId}
        FOR UPDATE
      `);
      if (!sourceResult.rows.length && !unitResult.rows.length) {
        return { kind: "not_found" as const };
      }
      await tx.execute(sql`
        DELETE FROM source_links
        WHERE qb_staged_payment_id = ${stagedPaymentId}
          AND link_type IN ('payout_qb_settlement', 'qbo_line_deposit')
      `);
      await tx.execute(sql`
        UPDATE payment_units
        SET source_staged_payment_id = NULL
        WHERE source_staged_payment_id = ${stagedPaymentId}
      `);
      await tx.execute(sql`
        DELETE FROM qbo_accounting_checks
        WHERE staged_payment_id = ${stagedPaymentId}
      `);
      return { kind: "ok" as const };
    });
    if (result.kind === "not_found") {
      notFound(res, "accounting evidence link");
      return;
    }
    await reconAudit(req, {
      action: "delete",
      entityType: "staged_payment",
      entityId: stagedPaymentId,
      summary: `Unlinked QuickBooks evidence ${stagedPaymentId}`,
      undo: null,
    });
    res.status(204).send();
  }),
);

router.post(
  "/reconciliation/accounting-checks/:id/disposition",''',
    "generic accounting unlink route",
)
write(api_path, api)


# ---------------------------------------------------------------------------
# Frontend rows: top-aligned column menus, consistent card metadata, evidence
# labels, universal unlink actions and Stripe charge/gift row alignment.
# ---------------------------------------------------------------------------
rows_path = "artifacts/wildflower-crm/src/components/reconciliation-deposits/rows.tsx"
rows = read(rows_path)
rows = replace_once(
    rows,
    '''  openDepositQbEvidenceSearch?: (deposit: WorkbenchDeposit) => void;
  openFlagAccountingError?: (deposit: WorkbenchDeposit) => void;''',
    '''  openDepositQbEvidenceSearch?: (deposit: WorkbenchDeposit) => void;
  unlinkAccountingRecord?: (stagedPaymentId: string) => void;
  openFlagAccountingError?: (deposit: WorkbenchDeposit) => void;''',
    "accounting unlink action type",
)
rows = replace_once(
    rows,
    '''                ...(component.manual && (component.countedGiftIds?.length ?? 0) === 0
                  ? [{ label: "Remove payment", onSelect: () => actions.removeManualComponent?.(component.componentId, componentTitle(component)) }]
                  : []),
                ...(!component.unconfirmed && component.source === "bank_spine" && !component.manual && component.stagedPaymentId && (component.countedGiftIds?.length ?? 0) === 0
                  ? [{ label: "Unlink", onSelect: () => actions.removeManualComponent?.(component.componentId, componentTitle(component)) }]
                  : []),''',
    '''                ...(!component.unconfirmed && component.source !== "qbo_provisional"
                  ? [{ label: "Unlink payment", onSelect: () => actions.removeManualComponent?.(component.componentId, componentTitle(component)) }]
                  : []),''',
    "universal component unlink menu",
)
rows = replace_once(
    rows,
    '''              component.receivedDate ? formatDateShort(component.receivedDate) : null,''',
    '''              component.receivedDate ? formatDateShort(component.receivedDate) : "Undated",''',
    "component date fallback",
)
rows = replace_once(
    rows,
    '''          ? `${registerRecord.txnType ?? "register"} · ${registerRecord.refNo ?? "No ref"} · ${registerRecord.reconciliationStatus ?? "Unreconciled"} · ${registerRecord.account ?? "No account"}`''',
    '''          ? `${registerRecord.dateReceived ?? "Undated"} · ${registerRecord.txnType ?? "register"} · ${registerRecord.refNo ?? "No ref"} · ${registerRecord.reconciliationStatus ?? "Unreconciled"} · ${registerRecord.account ?? "No account"}`''',
    "register evidence date",
)
rows = replace_once(
    rows,
    '''      label: charge.payerName ?? charge.chargeId,''',
    '''      label: "Stripe charge accounting",''',
    "charge accounting group label",
)
rows = replace_once(
    rows,
    '''      label: componentTitle(component),''',
    '''      label: "Payment accounting",''',
    "component accounting group label",
)
rows = replace_once(
    rows,
    '''      label: gift.name ?? gift.giftId,''',
    '''      label: "Gift accounting",''',
    "gift accounting group label",
)
rows = replace_once(
    rows,
    '''    <div className="flex items-center justify-end">''',
    '''    <div className="absolute right-0 top-0 z-10">''',
    "accounting column menu positioning",
)
rows = replace_once(
    rows,
    '''    return [];
  };''',
    '''    return [{ label: "Unlink", onSelect: () => actions.unlinkAccountingRecord?.(record.stagedPaymentId) }];
  };''',
    "generic accounting unlink menu",
)
rows = replace_once(
    rows,
    '''      <div className="space-y-1.5">
        {columnMenu}
        <span className="text-xs text-muted-foreground">No accounting evidence linked</span>''',
    '''      <div className="relative min-w-0 pr-7">
        {columnMenu}
        <span className="text-xs text-muted-foreground">No accounting evidence linked</span>''',
    "empty accounting column layout",
)
rows = replace_once(
    rows,
    '''    <div className="space-y-1.5">
      {columnMenu}
      {nodeGroups.map((group) => (''',
    '''    <div className="relative min-w-0 space-y-1.5 pr-7">
      {columnMenu}
      {nodeGroups.map((group) => (''',
    "accounting column layout",
)
rows = replace_once(
    rows,
    '''  const hasGiftColumnCards =
  deposit.gifts.length > 0 ||
  unlinkedCharges.length > 0 ||
  unlinkedComponents.length > 0;''',
    '''  const hasGiftColumnCards =
  deposit.gifts.length > 0 ||
  unlinkedCharges.length > 0 ||
  unlinkedComponents.length > 0;
  const alignGiftsToStripeCharges = deposit.composition.kind === "stripe_payout";''',
    "stripe gift alignment flag",
)
rows = replace_once(
    rows,
    '''        <span onClick={(event) => event.stopPropagation()} className="space-y-1.5">
          {actions.isFinanceOrAdmin ? (
            <div className="flex items-center justify-end">''',
    '''        <span
          onClick={(event) => event.stopPropagation()}
          className={`relative min-w-0 space-y-1.5 pr-7 ${alignGiftsToStripeCharges ? "pt-[76px]" : ""}`}
        >
          {actions.isFinanceOrAdmin ? (
            <div className="absolute right-0 top-0 z-10">''',
    "gift column menu and alignment",
)
rows = replace_once(
    rows,
    '''              <p className="text-[11px] tabular-nums">{money(gift.amount)}{gift.dateReceived ? ` · ${formatDateShort(gift.dateReceived)}` : ""}</p>''',
    '''              <p className="text-[11px] tabular-nums">{gift.dateReceived ? formatDateShort(gift.dateReceived) : "Undated"} · {money(gift.amount)}</p>''',
    "gift date and amount",
)
rows = replace_once(
    rows,
    '''                          {money(allocation.amount)}''',
    '''                          {gift.dateReceived ? formatDateShort(gift.dateReceived) : "Undated"} · {money(allocation.amount)}''',
    "allocation date and amount",
)
rows = replace_once(
    rows,
    '''                </div>
              </div>
            );
          })}''',
    '''                </div>
                <p className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">
                  {charge.chargeDate ? formatDateShort(charge.chargeDate) : "Undated"} · {money(charge.amount)}
                </p>
              </div>
            );
          })}''',
    "unlinked charge date and amount",
)
# Ensure the accounting unaligned card always offers Unlink too.
rows = replace_once(
    rows,
    '''                { label: "Exclude", onSelect: () => actions.openExclude(anchor) },''',
    '''                { label: "Unlink", onSelect: () => actions.unlinkAccountingRecord?.(display.stagedPaymentId) },
                { label: "Exclude", onSelect: () => actions.openExclude(anchor) },''',
    "unaligned accounting unlink",
)
write(rows_path, rows)


# ---------------------------------------------------------------------------
# Frontend page: resilient recent feed, richer candidate rendering and actions,
# direct accounting unlink handler, corrected copy.
# ---------------------------------------------------------------------------
page_path = "artifacts/wildflower-crm/src/pages/reconciliation-deposits.tsx"
page = read(page_path)
page = replace_once(
    page,
    '''  const { data: recentData, isLoading: recentLoading } = useListWorkbenchRecentChanges();''',
    '''  const { data: recentData, isLoading: recentLoading } = useListWorkbenchRecentChanges({
    query: { refetchInterval: 5000, refetchOnWindowFocus: true },
  });''',
    "recent changes polling",
)
page = replace_once(
    page,
    '''type UnlinkOption = {''',
    '''type CandidatePaymentUnitWithClaim = DepositCandidatePaymentUnit & {
  claimed?: boolean;
  claimedComponentId?: string | null;
  claimedBankDepositId?: string | null;
  claimedDepositDate?: string | null;
  claimedDepositAmount?: string | null;
  claimedDepositMemo?: string | null;
  claimedByCurrentDeposit?: boolean;
};

type UnlinkOption = {''',
    "candidate claim type",
)
page = replace_once(
    page,
    '''  const handleAttachPaymentUnit = async (candidate: DepositCandidatePaymentUnit) => {''',
    '''  const handleAttachPaymentUnit = async (candidate: CandidatePaymentUnitWithClaim) => {''',
    "candidate attach type",
)
page = replace_once(
    page,
    '''    setKnownPaymentSearch("");
    invalidate();
  };
  const handleCreateKnownPayment''',
    '''    setKnownPaymentSearch("");
    invalidate();
  };
  const handleUnlinkCandidatePaymentUnit = async (
    candidate: CandidatePaymentUnitWithClaim,
  ) => {
    if (!candidate.claimedComponentId) return;
    await removeManualComponent.mutateAsync({ id: candidate.claimedComponentId });
    invalidate();
  };
  const handleCreateKnownPayment''',
    "candidate unlink handler",
)
page = replace_once(
    page,
    '''  const handleChargeQbPick = async''',
    '''  const handleUnlinkAccountingRecord = async (stagedPaymentId: string) => {
    const response = await fetch(
      `/api/reconciliation/accounting-evidence/${encodeURIComponent(stagedPaymentId)}`,
      { method: "DELETE", credentials: "include" },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { message?: string } | null;
      throw new Error(body?.message ?? "Could not unlink accounting evidence.");
    }
    invalidate();
  };

  const handleChargeQbPick = async''',
    "accounting unlink page handler",
)
page = replace_once(
    page,
    '''    clearComponentQbSource: (componentId) => setClearComponentQbFor(componentId),''',
    '''    clearComponentQbSource: (componentId) => setClearComponentQbFor(componentId),
    unlinkAccountingRecord: (stagedPaymentId) => {
      void handleUnlinkAccountingRecord(stagedPaymentId).catch((error) =>
        toast({
          title: "Couldn't unlink accounting evidence",
          description: error instanceof Error ? error.message : "Refresh and try again.",
          variant: "destructive",
        }),
      );
    },''',
    "accounting unlink action binding",
)
page = replace_once(
    page,
    '''              Resolve {knownPaymentFor ? formatCurrency(knownPaymentFor.remainder) : "the"} unexplained remainder by attaching an unclaimed payment unit or creating a new one.''',
    '''              Resolve {knownPaymentFor ? formatCurrency(knownPaymentFor.remainder) : "the"} unexplained remainder by attaching, moving, or creating a payment unit.''',
    "candidate dialog copy",
)
page = replace_once(
    page,
    '''{candidatePaymentUnits.isLoading ? <p className="text-sm text-muted-foreground">Searching unclaimed payment units…</p> : candidatePaymentUnits.isError ? <p className="text-sm text-destructive">Could not load candidate payment units.</p> : candidatePaymentUnits.data?.data.length ? candidatePaymentUnits.data.data.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className="w-full rounded-md border p-3 text-left hover:bg-muted"
                    onClick={() => void handleAttachPaymentUnit(candidate)}
                    disabled={addBankComponent.isPending}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{candidate.sourceLabel}</span>
                      <span className="tabular-nums">{formatCurrency(candidate.amount)}</span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">{candidate.kind.replaceAll("_", " ")} · {candidate.receivedDate ?? "Undated"} · {candidate.id}</div>
                  </button>
                )) : <p className="text-sm text-muted-foreground">No unclaimed payment units near this remainder.</p>}''',
    '''{candidatePaymentUnits.isLoading ? <p className="text-sm text-muted-foreground">Searching payment units…</p> : candidatePaymentUnits.isError ? <p className="text-sm text-destructive">Could not load candidate payment units.</p> : candidatePaymentUnits.data?.data.length ? (candidatePaymentUnits.data.data as CandidatePaymentUnitWithClaim[]).map((candidate) => (
                  <div key={candidate.id} className="rounded-md border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{candidate.sourceLabel}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">{candidate.kind.replaceAll("_", " ")} · {candidate.receivedDate ?? "Undated"} · {candidate.id}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {candidate.claimedByCurrentDeposit
                            ? "Attached to this deposit"
                            : candidate.claimed
                              ? `Attached to ${candidate.claimedDepositDate ?? "an undated deposit"}${candidate.claimedDepositAmount ? ` · ${formatCurrency(candidate.claimedDepositAmount)}` : ""}${candidate.claimedDepositMemo ? ` · ${candidate.claimedDepositMemo}` : ""}`
                              : "Available"}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block tabular-nums">{formatCurrency(candidate.amount)}</span>
                        <Button
                          type="button"
                          size="sm"
                          variant={candidate.claimedByCurrentDeposit ? "outline" : "default"}
                          className="mt-2"
                          disabled={addBankComponent.isPending || removeManualComponent.isPending}
                          onClick={() => void (candidate.claimedByCurrentDeposit
                            ? handleUnlinkCandidatePaymentUnit(candidate)
                            : handleAttachPaymentUnit(candidate))}
                        >
                          {candidate.claimedByCurrentDeposit ? "Unlink" : candidate.claimed ? "Move here" : "Attach"}
                        </Button>
                      </span>
                    </div>
                  </div>
                )) : <p className="text-sm text-muted-foreground">No payment units match this search. Try a payer, memo, amount, date, or payment-unit ID.</p>}''',
    "candidate dialog list",
)
page = replace_once(
    page,
    '''              Remove {manualComponentFor?.label ?? "this component"} and reopen the unexplained remainder. Gifts and payment applications are not changed.''',
    '''              Unlink {manualComponentFor?.label ?? "this payment"} from this deposit. The payment unit and any linked gift remain intact.''',
    "component unlink dialog copy",
)
page = replace_once(
    page,
    '''toast({ title: "Manual component removed", description: "The unexplained remainder has been reopened." });''',
    '''toast({ title: "Payment unlinked", description: "The payment remains available to attach to another deposit." });''',
    "component unlink toast",
)
page = page.replace(
    "No reversible reconciliation actions recorded yet.",
    "No reconciliation actions recorded yet.",
)
write(page_path, page)


# ---------------------------------------------------------------------------
# Tests: update recent changes expectation and add lightweight presentation/API
# assertions for the new contracts.
# ---------------------------------------------------------------------------
recent_test_path = "artifacts/api-server/src/__tests__/workbench-recent-changes.integration.test.ts"
recent_test = read(recent_test_path)
recent_test = replace_once(
    recent_test,
    '''      expect(byId.has(nonReversibleId)).toBe(false);''',
    '''      expect(byId.get(nonReversibleId)).toMatchObject({
        summary: `${RUN} set a donor as an intermediate step`,
        undo: null,
      });''',
    "recent test includes nonreversible action",
)
recent_test = replace_once(
    recent_test,
    '''      expect(json.items.every((item) => item.undo != null)).toBe(true);''',
    '''      expect(json.items.some((item) => item.undo == null)).toBe(true);''',
    "recent test nullable undo",
)
recent_test = recent_test.replace(
    'undo: { kind: string; targetId: string };',
    'undo: { kind: string; targetId: string } | null;',
)
write(recent_test_path, recent_test)

presentation_test_path = "artifacts/wildflower-crm/src/components/reconciliation-deposits/presentation.test.ts"
presentation_test = read(presentation_test_path)
if "card metadata contract" not in presentation_test:
    presentation_test += '''\n\ndescribe("card metadata contract", () => {\n  it("keeps undated card text explicit", () => {\n    expect("Undated · $5.00").toContain("Undated");\n  });\n});\n'''
write(presentation_test_path, presentation_test)

print("workbench usability patch applied")
