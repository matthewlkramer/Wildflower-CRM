from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def load(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def save(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, repl: str, label: str, flags: int = 0) -> str:
    result, count = re.subn(pattern, repl, text, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f"{label}: expected one regex occurrence, found {count}")
    return result


# Recent changes: query the current reviewer in SQL, so their actions cannot be
# displaced by a busy team-wide audit stream.
recent_path = "artifacts/api-server/src/routes/reconciliation/recentChanges.ts"
recent = load(recent_path)
recent = replace_once(
    recent,
    'import { desc, eq, sql } from "drizzle-orm";',
    'import { and, desc, eq, sql } from "drizzle-orm";',
    "recent imports",
)
recent = replace_once(
    recent,
    '''        actorUserId: auditLog.actorUserId,
        actorName: actorNameExpr.as("actor_name"),''',
    '''        actorName: actorNameExpr.as("actor_name"),''',
    "remove recent actor select",
)
recent = replace_once(
    recent,
    '''      .where(sql`${auditLog.metadata} ->> 'domain' = 'reconciliation'`)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(500);''',
    '''      .where(
        and(
          eq(auditLog.actorUserId, user.id),
          sql`${auditLog.metadata} ->> 'domain' = 'reconciliation'`,
        ),
      )
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(100);''',
    "recent user query",
)
recent = replace_once(
    recent,
    '''    const items = rows
      .filter((row) => row.actorUserId === user.id)
      .map((row) => ({''',
    '''    const items = rows.map((row) => ({''',
    "recent in-memory user filter",
)
recent = replace_once(
    recent,
    '''        undo: undoOf(row.metadata),
      }))
      .slice(0, 20);''',
    '''        undo: undoOf(row.metadata),
      })).slice(0, 20);''',
    "recent map close",
)
save(recent_path, recent)


api_path = "artifacts/api-server/src/routes/reconciliation/workbenchDeposits.ts"
api = load(api_path)

# Preserve a claimed component's actual amount when moving it. A split/partial
# component may differ from the canonical unit total.
api = replace_once(
    api,
    '''          d2.deposit_date::text AS deposit_date,
          d2.amount::text AS deposit_amount,
          d2.memo AS deposit_memo''',
    '''          c.amount::text AS component_amount,
          d2.deposit_date::text AS deposit_date,
          d2.amount::text AS deposit_amount,
          d2.memo AS deposit_memo''',
    "claim component amount select",
)
api = replace_once(
    api,
    '''        claim.id AS claimed_component_id,
        claim.bank_deposit_id AS claimed_bank_deposit_id,
        claim.deposit_date,''',
    '''        claim.id AS claimed_component_id,
        claim.bank_deposit_id AS claimed_bank_deposit_id,
        claim.component_amount AS claimed_component_amount,
        claim.deposit_date,''',
    "claim component amount projection",
)
api = replace_once(
    api,
    '''          claimed_bank_deposit_id: string | null;
          deposit_date: string | null;''',
    '''          claimed_bank_deposit_id: string | null;
          claimed_component_amount: string | null;
          deposit_date: string | null;''',
    "claim component amount type",
)
api = replace_once(
    api,
    '''        claimedBankDepositId: row.claimed_bank_deposit_id,
        claimedDepositDate: row.deposit_date,''',
    '''        claimedBankDepositId: row.claimed_bank_deposit_id,
        claimedComponentAmount: row.claimed_component_amount,
        claimedDepositDate: row.deposit_date,''',
    "claim component amount response",
)
api = replace_once(
    api,
    '''          SELECT id, bank_deposit_id
          FROM bank_deposit_components''',
    '''          SELECT id, bank_deposit_id, amount::text AS amount
          FROM bank_deposit_components''',
    "claimed component move select",
)
api = replace_once(
    api,
    '''          claimed.rows as Array<{ id: string; bank_deposit_id: string }>
        )[0];''',
    '''          claimed.rows as Array<{
            id: string;
            bank_deposit_id: string;
            amount: string;
          }>
        )[0];''',
    "claimed component move type",
)
api = replace_once(
    api,
    '''        componentAmount =
          body.amount == null ? Number(unit.amount ?? 0) : Number(body.amount);''',
    '''        componentAmount =
          body.amount == null
            ? Number(existingClaim?.amount ?? unit.amount ?? 0)
            : Number(body.amount);''',
    "preserve moved component amount",
)

# Replace the over-broad accounting unlink with a deposit-scoped relationship
# unlink. It only removes the exact source_link represented by the displayed
# card and never clears payment-unit source pointers globally.
accounting_pattern = r'''router\.delete\(\n  "/reconciliation/accounting-evidence/:stagedPaymentId",.*?\n\);\n\nrouter\.post\(\n  "/reconciliation/accounting-checks/:id/disposition",'''
accounting_replacement = '''router.delete(
  "/reconciliation/deposits/:bankDepositId/accounting-evidence/:stagedPaymentId",
  asyncHandler(async (req, res) => {
    if (!requireFinance(req, res)) return;
    const bankDepositId = String(req.params.bankDepositId ?? "");
    const stagedPaymentId = String(req.params.stagedPaymentId ?? "");
    const role = typeof req.query.role === "string" ? req.query.role : "";
    const linkedChargeId =
      typeof req.query.linkedChargeId === "string"
        ? req.query.linkedChargeId
        : null;
    const bankTransactionId =
      typeof req.query.bankTransactionId === "string"
        ? req.query.bankTransactionId
        : null;
    if (!bankDepositId || !stagedPaymentId) {
      res.status(400).json({
        error: "validation_error",
        message: "A bank deposit id and accounting record id are required.",
      });
      return;
    }

    const result = await db.transaction(async (tx) => {
      if (bankTransactionId) {
        const deleted = await tx.execute(sql`
          DELETE FROM source_links
          WHERE link_type = 'qbo_register_deposit'
            AND bank_deposit_id = ${bankDepositId}
            AND bank_transaction_id = ${bankTransactionId}
          RETURNING id
        `);
        return deleted.rows.length
          ? { kind: "ok" as const, label: bankTransactionId }
          : { kind: "not_found" as const };
      }

      if (role === "fee" && linkedChargeId) {
        const deleted = await tx.execute(sql`
          DELETE FROM source_links
          WHERE link_type = 'charge_fee_row'
            AND qb_staged_payment_id = ${stagedPaymentId}
            AND stripe_charge_id = ${linkedChargeId}
          RETURNING id
        `);
        return deleted.rows.length
          ? { kind: "ok" as const, label: stagedPaymentId }
          : { kind: "not_found" as const };
      }

      if (role === "deposit") {
        const qboLine = await tx.execute(sql`
          DELETE FROM source_links
          WHERE link_type = 'qbo_line_deposit'
            AND bank_deposit_id = ${bankDepositId}
            AND qb_staged_payment_id = ${stagedPaymentId}
          RETURNING id
        `);
        const payoutSettlement = await tx.execute(sql`
          DELETE FROM source_links sl
          USING stripe_payouts payout
          WHERE sl.link_type = 'payout_qb_settlement'
            AND sl.stripe_payout_id = payout.id
            AND payout.bank_deposit_id = ${bankDepositId}
            AND sl.qb_staged_payment_id = ${stagedPaymentId}
          RETURNING sl.id
        `);
        if (!qboLine.rows.length && !payoutSettlement.rows.length) {
          return { kind: "not_found" as const };
        }
        await tx.execute(sql`
          DELETE FROM qbo_accounting_checks check_row
          WHERE check_row.staged_payment_id = ${stagedPaymentId}
            AND NOT EXISTS (
              SELECT 1
              FROM source_links remaining
              WHERE remaining.link_type = 'payout_qb_settlement'
                AND remaining.qb_staged_payment_id = ${stagedPaymentId}
            )
        `);
        return { kind: "ok" as const, label: stagedPaymentId };
      }

      return { kind: "unsupported" as const };
    });

    if (result.kind === "not_found") {
      notFound(res, "accounting evidence link");
      return;
    }
    if (result.kind === "unsupported") {
      res.status(409).json({
        error: "unsupported_accounting_unlink",
        message: "This accounting relationship must be unlinked from its source card.",
      });
      return;
    }
    await reconAudit(req, {
      action: "delete",
      entityType: "staged_payment",
      entityId: result.label,
      summary: `Unlinked QuickBooks evidence ${result.label} from deposit ${bankDepositId}`,
      undo: null,
      extra: { bankDepositId, role },
    });
    res.status(204).send();
  }),
);

router.post(
  "/reconciliation/accounting-checks/:id/disposition",'''
api = regex_once(
    api,
    accounting_pattern,
    accounting_replacement,
    "scoped accounting unlink route",
    flags=re.S,
)
save(api_path, api)


rows_path = "artifacts/wildflower-crm/src/components/reconciliation-deposits/rows.tsx"
rows = load(rows_path)
rows = replace_once(
    rows,
    '''  unlinkAccountingRecord?: (stagedPaymentId: string) => void;''',
    '''  unlinkAccountingRecord?: (
    bankDepositId: string,
    record: WorkbenchDepositNodeQbRecord | WorkbenchDepositQbRecord,
  ) => void;''',
    "accounting action signature",
)
rows = replace_once(
    rows,
    '''    if ("bankTransactionId" in record && record.bankTransactionId) return [];
    if (record.role === "component" && record.componentId) {''',
    '''    if (record.role === "component" && record.componentId) {''',
    "register accounting menu",
)
rows = replace_once(
    rows,
    '''        onSelect: () =>
          actions.unlinkAccountingRecord?.(record.stagedPaymentId),''',
    '''        onSelect: () =>
          actions.unlinkAccountingRecord?.(deposit.anchorId, record),''',
    "node accounting unlink call",
)
rows = replace_once(
    rows,
    '''                    {
                      label: "Unlink",
                      onSelect: () =>
                        actions.unlinkAccountingRecord?.(
                          display.stagedPaymentId,
                        ),
                    },
                    {
                      label: "Exclude",''',
    '''                    ...(record
                      ? [
                          {
                            label: "Unlink",
                            onSelect: () =>
                              actions.unlinkAccountingRecord?.(
                                deposit.anchorId,
                                record,
                              ),
                          },
                        ]
                      : []),
                    {
                      label: "Exclude",''',
    "unaligned accounting unlink call",
)
save(rows_path, rows)


page_path = "artifacts/wildflower-crm/src/pages/reconciliation-deposits.tsx"
page = load(page_path)
page = replace_once(
    page,
    '''  type WorkbenchDeposit,
  type WorkbenchDepositCompositionComponentsItem,''',
    '''  type WorkbenchDeposit,
  type WorkbenchDepositNodeQbRecord,
  type WorkbenchDepositQbRecord,
  type WorkbenchDepositCompositionComponentsItem,''',
    "deposit accounting record imports",
)
page = replace_once(
    page,
    '''  claimedBankDepositId?: string | null;
  claimedDepositDate?: string | null;''',
    '''  claimedBankDepositId?: string | null;
  claimedComponentAmount?: string | null;
  claimedDepositDate?: string | null;''',
    "claimed component amount page type",
)
page = regex_once(
    page,
    r'''  const handleUnlinkAccountingRecord = async \(stagedPaymentId: string\) => \{.*?\n  \};\n\n  const handleChargeQbPick''',
    '''  const handleUnlinkAccountingRecord = async (
    bankDepositId: string,
    record: WorkbenchDepositNodeQbRecord | WorkbenchDepositQbRecord,
  ) => {
    const query = new URLSearchParams({ role: record.role });
    if (record.linkedChargeId) {
      query.set("linkedChargeId", record.linkedChargeId);
    }
    if ("bankTransactionId" in record && record.bankTransactionId) {
      query.set("bankTransactionId", record.bankTransactionId);
    }
    const response = await fetch(
      `/api/reconciliation/deposits/${encodeURIComponent(bankDepositId)}/accounting-evidence/${encodeURIComponent(record.stagedPaymentId)}?${query.toString()}`,
      { method: "DELETE", credentials: "include" },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new Error(body?.message ?? "Could not unlink accounting evidence.");
    }
    invalidate();
  };

  const handleChargeQbPick''',
    "scoped accounting page handler",
    flags=re.S,
)
page = replace_once(
    page,
    '''    unlinkAccountingRecord: (stagedPaymentId) => {
      void handleUnlinkAccountingRecord(stagedPaymentId).catch((error) =>''',
    '''    unlinkAccountingRecord: (bankDepositId, record) => {
      void handleUnlinkAccountingRecord(bankDepositId, record).catch((error) =>''',
    "scoped accounting action binding",
)
page = replace_once(
    page,
    '''                              ? `Attached to ${candidate.claimedDepositDate ?? "an undated deposit"}${candidate.claimedDepositAmount ? ` · ${formatCurrency(candidate.claimedDepositAmount)}` : ""}${candidate.claimedDepositMemo ? ` · ${candidate.claimedDepositMemo}` : ""}`''',
    '''                              ? `Attached to ${candidate.claimedDepositDate ?? "an undated deposit"}${candidate.claimedComponentAmount ? ` · component ${formatCurrency(candidate.claimedComponentAmount)}` : ""}${candidate.claimedDepositAmount ? ` · deposit ${formatCurrency(candidate.claimedDepositAmount)}` : ""}${candidate.claimedDepositMemo ? ` · ${candidate.claimedDepositMemo}` : ""}`''',
    "claimed component amount candidate copy",
)
save(page_path, page)


test_path = "artifacts/api-server/src/__tests__/workbench-deposits.integration.test.ts"
test = load(test_path)
addition = r'''

  it("lists claimed payment units and moves the existing partial component without changing its amount", async () => {
    const sourceDeposit = await seedDeposit("Claimed component source", "40.00");
    const targetDeposit = await seedDeposit("Claimed component target", "50.00");
    const unitId = nextId("claimed_unit");
    const componentId = nextId("claimed_component");
    await db.insert(schema.paymentUnits).values({
      id: unitId,
      kind: "check",
      grossAmount: "100.00",
      netAmount: "100.00",
      receivedDate: "2099-12-30",
    });
    await db.insert(schema.bankDepositComponents).values({
      id: componentId,
      bankDepositId: sourceDeposit,
      paymentUnitId: unitId,
      amount: "40.00",
      source: "manual",
    });
    unitIds.push(unitId);
    componentIds.push(componentId);

    const candidates = await getJson(
      `/api/reconciliation/deposits/${targetDeposit}/candidate-payment-units?q=${unitId}`,
    );
    expect(candidates.status).toBe(200);
    expect(candidates.json.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: unitId,
          amount: "100.00",
          claimed: true,
          claimedComponentId: componentId,
          claimedBankDepositId: sourceDeposit,
          claimedComponentAmount: "40.00",
          claimedByCurrentDeposit: false,
        }),
      ]),
    );

    const moved = await postJson(
      `/api/reconciliation/deposits/${targetDeposit}/components`,
      { mode: "attach", paymentUnitId: unitId },
    );
    expect(moved.status).toBe(201);
    expect(moved.json).toMatchObject({
      id: componentId,
      paymentUnitId: unitId,
      amount: "40.00",
    });
    const component = await db.query.bankDepositComponents.findFirst({
      where: eqFn(schema.bankDepositComponents.id, componentId),
    });
    expect(component).toMatchObject({
      bankDepositId: targetDeposit,
      amount: "40.00",
    });
  });

  it("unlinks only the displayed deposit accounting relationship", async () => {
    const depositId = await seedDeposit("Scoped accounting unlink", "75.00");
    const payoutId = await seedPayout("75.00", depositId);
    const stagedPaymentId = nextId("scoped_qbo");
    const sourceLinkId = nextId("scoped_source_link");
    const unitId = nextId("shared_source_unit");
    await db.insert(schema.stagedPayments).values({
      id: stagedPaymentId,
      realmId: RUN,
      qbEntityType: "deposit",
      qbEntityId: nextId("qb_deposit"),
      dateReceived: "2099-12-31",
      amount: "75.00",
    });
    stagedIds.push(stagedPaymentId);
    await db.insert(schema.sourceLinks).values({
      id: sourceLinkId,
      linkType: "payout_qb_settlement",
      stripePayoutId: payoutId,
      qbStagedPaymentId: stagedPaymentId,
      lifecycle: "confirmed",
      provenance: "human",
      matchBasis: "settled_pairing",
    });
    depositQboComponentIds.push(sourceLinkId);
    await db.insert(schema.paymentUnits).values({
      id: unitId,
      kind: "check",
      grossAmount: "75.00",
      netAmount: "75.00",
      receivedDate: "2099-12-31",
      sourceStagedPaymentId: stagedPaymentId,
    });
    unitIds.push(unitId);

    const response = await requestJson(
      "DELETE",
      `/api/reconciliation/deposits/${depositId}/accounting-evidence/${stagedPaymentId}?role=deposit`,
    );
    expect(response.status).toBe(204);
    const remainingLink = await db.query.sourceLinks.findFirst({
      where: eqFn(schema.sourceLinks.id, sourceLinkId),
    });
    expect(remainingLink).toBeUndefined();
    const preservedUnit = await db.query.paymentUnits.findFirst({
      where: eqFn(schema.paymentUnits.id, unitId),
    });
    expect(preservedUnit?.sourceStagedPaymentId).toBe(stagedPaymentId);
  });
'''
if addition.strip() not in test:
    if not test.endswith("\n});\n"):
        raise SystemExit("deposit integration test final closure not found")
    test = test[:-5] + addition + "\n});\n"
save(test_path, test)

print("workbench usability refinements applied")
