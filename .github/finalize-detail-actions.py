from pathlib import Path


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one anchor, found {count}")
    path.write_text(text.replace(old, new, 1))


# Keep generated output reproducible without reformatting every unrelated client.
normalization = '''# Orval emits trailing spaces in some operation templates. Normalize the
# files affected by this contract change, plus the existing reconciliation
# output, so codegen remains byte-stable without reformatting unrelated files.
for rel in \\
  reconciliation/reconciliation.ts \\
  gifts-and-payments/gifts-and-payments.ts \\
  opportunities-and-pledges/opportunities-and-pledges.ts; do
  file="$tmp/lib/api-client-react/src/generated/$rel"
  [ -f "$file" ] && sed -i 's/[[:space:]]*$//' "$file"
done'''

for name in ("codegen.sh", "codegen-check.sh"):
    path = Path("lib/api-spec") / name
    text = path.read_text()
    old_long = '''# Orval emits trailing spaces in this file's bodyless mutation templates.
# Normalize the whole file so output is byte-stable and future mutation
# operations need no per-operation handling.
sed -i 's/[[:space:]]*$//' \\
  "$tmp/lib/api-client-react/src/generated/reconciliation/reconciliation.ts"'''
    old_short = '''sed -i 's/[[:space:]]*$//' \\
  "$tmp/lib/api-client-react/src/generated/reconciliation/reconciliation.ts"'''
    if old_long in text:
        text = text.replace(old_long, normalization, 1)
    elif old_short in text:
        text = text.replace(old_short, normalization, 1)
    elif "files affected by this contract change" not in text:
        raise SystemExit(f"Could not find codegen normalization anchor in {path}")
    path.write_text(text)


# Detach-from-pledge is intentionally unavailable for a gift whose retained link
# is to an ordinary opportunity rather than a finalized pledge.
route = Path("artifacts/api-server/src/routes/fundraisingRecordActions.ts")
replace_once(
    route,
    '''      if (!gift) return null;
      if (!gift.opportunityId) return { kind: "not_linked" as const };
      formerOpportunityId = gift.opportunityId;
      await tx''',
    '''      if (!gift) return null;
      if (!gift.opportunityId) return { kind: "not_linked" as const };
      const linkedRecord = await tx
        .select({
          pledgeCommittedAt: opportunitiesAndPledges.pledgeCommittedAt,
          commitmentPath: opportunitiesAndPledges.commitmentPath,
          writtenPledge: opportunitiesAndPledges.writtenPledge,
        })
        .from(opportunitiesAndPledges)
        .where(eq(opportunitiesAndPledges.id, gift.opportunityId))
        .for("update")
        .then((rows) => rows[0] ?? null);
      const finalizedPledge =
        linkedRecord != null &&
        (linkedRecord.pledgeCommittedAt != null ||
          (linkedRecord.commitmentPath == null &&
            linkedRecord.writtenPledge === true));
      if (!finalizedPledge) return { kind: "not_pledge" as const };
      formerOpportunityId = gift.opportunityId;
      await tx''',
    "detach finalized-pledge guard",
)
replace_once(
    route,
    '''    if (changed.kind === "not_linked") {
      res.status(409).json({
        error: "gift_not_on_pledge",
        message: "This gift is already a stand-alone gift.",
      });
      return;
    }
    await applyDerivedOppFieldsMany(formerOpportunityId);''',
    '''    if (changed.kind === "not_linked") {
      res.status(409).json({
        error: "gift_not_on_pledge",
        message: "This gift is already a stand-alone gift.",
      });
      return;
    }
    if (changed.kind === "not_pledge") {
      res.status(409).json({
        error: "gift_not_on_pledge",
        message:
          "This gift is linked to an opportunity rather than a finalized pledge. Use the appropriate opportunity correction instead.",
      });
      return;
    }
    await applyDerivedOppFieldsMany(formerOpportunityId);''',
    "detach ordinary-opportunity response",
)


# Stripe evidence linked to a non-pledge opportunity is a stand-alone gift, not a
# pledge payment; keep the audit summary aligned with the derived gift type.
stripe = Path("artifacts/api-server/src/routes/stripe.ts")
replace_once(
    stripe,
    '''            audit: {
              summary:
                "Minted gift from Stripe charge as a payment on a pledge",
              metadata: {''',
    '''            audit: {
              summary: opp.pledgeCommittedAt
                ? "Minted gift from Stripe charge as a payment on a pledge"
                : "Minted stand-alone gift from Stripe charge against an opportunity",
              metadata: {''',
    "Stripe opportunity audit summary",
)


# In ask-each-time mode, choosing a donor in the picker is the deliberate route
# decision. Do not block the action after that explicit choice.
for filename in (
    "artifacts/wildflower-crm/src/components/record-received-gift-dialog.tsx",
    "artifacts/wildflower-crm/src/components/pending-gift-dialog.tsx",
):
    path = Path(filename)
    text = path.read_text()
    text = text.replace(
        ": donorId && !routing.isLoading && !requiresDecision\n      ?",
        ": donorId && !routing.isLoading\n      ?",
    )
    text = text.replace(
        "if (!paymentDonor || requiresDecision) return;",
        "if (!paymentDonor) return;",
    )
    text = text.replace(
        "disabled={!paymentDonor || routing.isLoading || requiresDecision}",
        "disabled={!paymentDonor || routing.isLoading}",
    )
    text = text.replace(
        "    !routing.isLoading &&\n    !requiresDecision &&\n    !create.isPending;",
        "    !routing.isLoading &&\n    !create.isPending;",
    )
    text = text.replace(
        "This donor is set to ask each time. Choose the intended donor of\n                record directly before continuing.",
        "This donor is set to ask each time. Continuing explicitly uses\n                the donor currently selected above for this record.",
    )
    path.write_text(text)


# Regression coverage: the pledge-detachment correction must not sever a normal
# opportunity-to-gift history link.
test = Path(
    "artifacts/api-server/src/__tests__/fundraising-record-actions.integration.test.ts"
)
text = test.read_text()
replace_once(
    test,
    'const DETACH_UNIT = `${RUN}_detach_unit`;',
    '''const DETACH_UNIT = `${RUN}_detach_unit`;

const ORDINARY_OPP = `${RUN}_ordinary_opp`;
const ORDINARY_GIFT = `${RUN}_ordinary_gift`;''',
    "ordinary opportunity constants",
)
text = test.read_text()
replace_once(
    test,
    '''    pledgeValues(DETACH_PLEDGE, "80.00"),
  ]);''',
    '''    pledgeValues(DETACH_PLEDGE, "80.00"),
    {
      id: ORDINARY_OPP,
      name: `Ordinary opportunity ${RUN}`,
      organizationId: ORG_A,
      stage: "in_conversation",
      askAmount: "40.00",
    },
  ]);''',
    "ordinary opportunity seed",
)
replace_once(
    test,
    '''    {
      id: DETACH_GIFT,
      organizationId: ORG_A,
      opportunityId: DETACH_PLEDGE,
      amount: "80.00",
      dateReceived: "2026-02-04",
    },
  ]);''',
    '''    {
      id: DETACH_GIFT,
      organizationId: ORG_A,
      opportunityId: DETACH_PLEDGE,
      amount: "80.00",
      dateReceived: "2026-02-04",
    },
    {
      id: ORDINARY_GIFT,
      organizationId: ORG_A,
      opportunityId: ORDINARY_OPP,
      amount: "40.00",
      dateReceived: "2026-02-05",
    },
  ]);''',
    "ordinary opportunity gift seed",
)
replace_once(
    test,
    '''  it("blocks generic gift linkage and donor edits that need correction workflows", async () => {''',
    '''  it("does not detach a gift from an ordinary opportunity through the pledge correction", async () => {
    const result = await request(
      "POST",
      `/api/gifts-and-payments/${ORDINARY_GIFT}/detach-from-pledge`,
      { reason: "Incorrect correction path." },
    );
    expect(result.status).toBe(409);
    expect(result.json.error).toBe("gift_not_on_pledge");
    const [gift] = await db
      .select()
      .from(schema.giftsAndPayments)
      .where(eqFn(schema.giftsAndPayments.id, ORDINARY_GIFT));
    expect(gift.opportunityId).toBe(ORDINARY_OPP);
  });

  it("blocks generic gift linkage and donor edits that need correction workflows", async () => {''',
    "ordinary opportunity regression test",
)


# Structural assertions before expensive generation and tests.
assert "not_pledge" in route.read_text()
assert "Minted stand-alone gift from Stripe charge against an opportunity" in stripe.read_text()
assert "ORDINARY_OPP" in test.read_text()
for filename in (
    "artifacts/wildflower-crm/src/components/record-received-gift-dialog.tsx",
    "artifacts/wildflower-crm/src/components/pending-gift-dialog.tsx",
):
    text = Path(filename).read_text()
    assert "Continuing explicitly uses" in text
