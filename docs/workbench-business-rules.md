# Reconciliation Workbench Business Rules

## 1. Overview

Each workbench row represents a set of potentially related evidence across three semantic columns:

1. **Accounting evidence** — normally QuickBooks records
2. **Transaction evidence** — Stripe charges or other records showing that money moved
3. **CRM evidence** — gifts, allocations, donors, coding forms, grant letters, and related fundraising records

A row has:

* A **link status**, describing whether the evidence is connected
* An **information status**, describing whether the records contain the required information
* Optional **row-level flags**
* Separate **column and card statuses**
* Actions determined by state, source, and user permissions

A single physical record may satisfy more than one semantic role. For example, a QuickBooks ACH or check may serve as both transaction evidence and accounting evidence.

---

# 2. Row Status

The row status consists of two independently derived signals:

1. **Link completeness**
2. **Information completeness**

Optional row flags are displayed alongside those signals but do not replace them.

## 2.1 Link completeness

Link completeness answers:

> Are the accounting, transaction, and CRM records connected with complete, non-overlapping amount coverage?

| Value           | Meaning                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `complete`      | Every required evidence unit is connected across the applicable columns, amounts reconcile within tolerance, and the relationships use a valid grain mapping |
| `partial`       | At least one valid relationship exists, but one or more required links, evidence units, or amounts remain uncovered                                          |
| `mixed`         | The chain is otherwise complete, but competing unit- and bundle-level relationships overlap or create ambiguous coverage                                     |
| `partial_mixed` | Coverage is incomplete and the relationships that do exist also contain competing or overlapping grains                                                      |
| `missing`       | Evidence exists in only one semantic column and is not linked to evidence in another column                                                                  |

### Valid changes in grain

Different grain sizes between columns do not automatically create a mixed state.

This may be a valid complete chain:

```text
One QuickBooks deposit
→ several Stripe charges
→ several CRM gifts
```

The QuickBooks side is bundle-grain while the transaction and CRM sides are unit-grain, but the relationships may still be complete and unambiguous.

### Mixed grain

`mixed` means that competing representations exist for the same role or amount. For example:

```text
Individual Stripe charges link to individual CRM gifts
AND
the payout-level QuickBooks deposit links to another bundle-level CRM gift
```

Both representations claim the same underlying money. That is mixed because the coverage overlaps.

### CRM-only rows

For `crm_only` rows, transaction and accounting evidence are absent. The link status is therefore:

```text
missing
```

This means only that the CRM evidence has not been connected to transaction or accounting evidence in the system.

It does **not** establish why that evidence is absent. Possible explanations include:

* A payment exists but has not yet been found
* A payment exists but has not yet been linked
* The expected payment has not yet occurred
* No payment will occur

Those are hypotheses or workflow possibilities, not row states.

### Refunded transactions

Refunds do not create a row-level refund status.

When an individual transaction is refunded:

* That transaction no longer counts as live payment evidence.
* Any other non-refunded transactions in the row continue to count normally.
* If no live transaction remains and the CRM gift remains active, the row has `missing` or `partial` link coverage depending on what other evidence remains.
* The system does not infer from the refund alone whether a replacement payment exists, will arrive later, or will never arrive.
* The CRM record remains active until a replacement transaction is linked or the gift or opportunity is marked lost or dormant.

---

## 2.2 Information completeness

Information completeness answers:

> Do the CRM and accounting records contain the information required for fundraising administration, accounting, and audit support?

| Value                | Meaning                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `audit_ready`        | CRM information is complete and all required information has been documented on the relevant QuickBooks records |
| `accounting_pending` | CRM information is complete, but required information has not yet been transcribed or documented in QuickBooks  |
| `incomplete`         | At least one CRM card on the row does not satisfy a canonical CRM-completeness path                             |

QuickBooks completeness is downstream of CRM completeness:

```text
CRM incomplete → incomplete
CRM complete + QB incomplete → accounting_pending
CRM complete + QB complete → audit_ready
```

A CRM-only row can therefore be:

```text
link status: missing
information status: accounting_pending
```

The CRM card may be fully complete even though no transaction or accounting evidence has yet been linked.

The required fields are conditional on the transaction and gift type. For example:

* Stripe payments may require processor, routing, payout, and fee information.
* Direct checks and ACH payments do not require Stripe routing or fee information.
* Restricted grants may require restrictions, documentation, and reporting obligations.
* Ordinary unrestricted gifts may require a smaller information set.

The system should derive applicable requirements from the source, payment method, gift type, and restrictions rather than use one universal checklist.

---

# 3. CRM Record Completeness

A CRM gift is complete when it satisfies one of the following canonical paths.

These rules apply to every CRM card on the row, whether or not that card is linked to another card.

## 3.1 Donorbox path

The gift has a valid linked Donorbox record containing the required donor and purpose information.

## 3.2 Completed coding-form path

The gift has:

* A linked coding form
* The coding form is complete
* All fields required by the coding form have been completed
* A grant letter is attached when such a letter exists
* A grant letter is required when known donor restrictions make supporting documentation necessary

The mere existence of a coding-form record, or the presence of one populated coding-form field, does not make the gift complete.

A partially completed coding form does not satisfy this path.

## 3.3 Donor, allocations, and supporting-document path

The gift has:

* A linked donor
* At least one allocation row
* Every relevant allocation row has all applicable restriction information completed
* A grant letter is attached when such a letter exists
* A grant letter is required whenever donor restrictions are present

Applicable allocation information may include:

* Recipient entity, project, or school
* Time restriction type
* Spending start and end dates when time-restricted
* Usage restriction type
* Purpose or restriction description when usage-restricted
* Regional restriction type
* Regions when regionally restricted
* Reporting obligations or other required terms

A gift with a donor but no allocation rows is not complete.

A gift with incomplete restriction-type fields is not complete.

## 3.4 Satisfaction path

The API should expose how each gift became complete:

```ts
satisfiedBy:
  | "donorbox"
  | "completed_coding_form"
  | "donor_allocations_and_supporting_documents"
  | null;
```

This may be displayed as:

* Complete · Donorbox
* Complete · completed coding form
* Complete · donor and allocations
* Complete · donor, allocations, and grant letter

The display should reflect whether supporting documentation was actually required and present.

---

# 4. Row-Level Flags

Flags are independent of link and information statuses and may be combined.

| Flag                 | Meaning                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `excluded`           | The row is excluded from goals, active reconciliation, and audit coverage                                        |
| `conflict`           | Two or more authoritative records make materially incompatible claims                                            |
| `attention_required` | The row contains an unresolved condition that requires user review but is not necessarily a direct contradiction |

Refund is not a row-level flag. It belongs to an individual transaction card.

## 4.1 Conflict rules

A conflict exists when authoritative evidence cannot simultaneously be correct, such as:

* Different donor identities for the same gift
* Incompatible CRM and transaction amounts
* Incompatible restrictions
* Contradictory recipient entities
* Different dates where the sources purport to represent the same date concept

Expected date differences are not conflicts. For example:

* Stripe charge date
* Stripe payout date
* Bank deposit date
* QuickBooks posting date
* CRM gift date

may legitimately differ.

Amount differences caused by known fees, splits, refunds, or aggregation are also not conflicts when the relationship explains them.

---

# 5. Transaction Column

Transaction evidence represents live payments that moved or are expected to move money.

Stripe charges are transaction evidence regardless of whether a CRM gift has been linked.

Donorbox is not transaction evidence. Donorbox supplies donor and purpose information, while the underlying transaction occurs through Stripe, PayPal, ACH, check, or another payment channel.

## 5.1 Transaction card states

Transaction state combines the card’s relationship state with any transaction-specific disposition.

| State                | Meaning                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `unmatched`          | A live transaction exists but is not linked to CRM or accounting evidence                                   |
| `partial`            | Some of the transaction amount or transaction units are linked, but coverage is incomplete                  |
| `amount_mismatch`    | Links exist, but applied amounts do not reconcile within tolerance                                          |
| `info_conflict`      | Amounts reconcile, but transaction and linked metadata materially conflict                                  |
| `matched`            | Required links are present, amounts reconcile, and no material conflict exists                              |
| `refund_anticipated` | A user has indicated that the transaction is expected to be reversed, but the reversal has not yet occurred |
| `refunded`           | The transaction has been reversed and no longer counts as live payment evidence                             |
| `excluded`           | The transaction is intentionally excluded from active reconciliation                                        |

`refund_anticipated` and `refunded` apply only to the individual transaction.

If a row contains one refunded transaction and one live matched transaction, the live transaction continues to support the row.

## 5.2 Transaction actions

| Action                           | Availability                                                       |
| -------------------------------- | ------------------------------------------------------------------ |
| Match to existing CRM gift       | Unmatched, partial, or amount-mismatch states                      |
| Match to QuickBooks evidence     | Unmatched, partial, or amount-mismatch states                      |
| Create new CRM gift              | Unmatched transaction                                              |
| Confirm proposed match           | System has proposed a match                                        |
| Unmatch from CRM gift            | Any transaction with a CRM relationship                            |
| Unmatch from QuickBooks evidence | Any transaction with an accounting relationship                    |
| Mark refund anticipated          | Any non-refunded, non-excluded transaction                         |
| Clear refund anticipated         | Transaction is marked refund anticipated but has not been refunded |
| Exclude transaction              | Any non-excluded transaction                                       |
| Un-exclude transaction           | Excluded transaction                                               |
| View processor record            | Any transaction with an external source record                     |

---

# 6. Settlement-Link State

For Stripe payout clusters, settlement-link state describes the relationship between the payout and QuickBooks accounting evidence.

It is distinct from the state of the QuickBooks record itself.

## 6.1 Settlement-link states

| State               | Meaning                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `unlinked`          | The payout has no QuickBooks settlement relationship                                                |
| `proposed_full`     | A proposed QuickBooks record fully represents the payout within tolerance                           |
| `proposed_partial`  | The proposed relationship covers only part of the payout or contains an unexplained amount variance |
| `proposed_conflict` | The proposal overlaps or contradicts another accounting relationship                                |
| `confirmed`         | The payout-to-QuickBooks settlement relationship has been confirmed                                 |

A bundle-level QuickBooks deposit connected to multiple individual Stripe charges is not inherently a conflict. It is a normal bundle-to-unit mapping when amounts reconcile and no competing accounting relationship exists.

## 6.2 Settlement-link actions

| Action                                     | Availability                                                 |
| ------------------------------------------ | ------------------------------------------------------------ |
| Propose settlement by searching QuickBooks | Unlinked                                                     |
| Confirm settlement                         | Proposed full or proposed partial, subject to validation     |
| Remove proposal                            | Any proposed state                                           |
| View QuickBooks record                     | Any proposed or confirmed relationship                       |
| Unmatch confirmed settlement               | Confirmed, subject to permissions and safeguards             |
| Replace settlement relationship            | Confirmed or proposed, subject to permissions and safeguards |

Only authorized finance-team members may create, confirm, remove, replace, or unmatch accounting relationships when the action changes or controls QuickBooks treatment.

---

# 7. QuickBooks Column

The QuickBooks column represents accounting records and their relationship and information completeness.

## 7.1 QuickBooks record states

| State                              | Meaning                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `raw`                              | Imported QuickBooks or bank-feed record with only basic source information such as date and amount           |
| `enriched`                         | Additional accounting information has been entered, but the record remains unmatched or not fully reconciled |
| `match_proposed`                   | A match to a CRM gift or transaction has been proposed but not yet confirmed                                  |
| `matched_complete`                 | All in-scope amount and evidence units are covered by valid relationships                                    |
| `matched_partial_qb_surplus`       | The QuickBooks record contains more money than linked transaction or CRM evidence accounts for               |
| `matched_partial_external_surplus` | Linked transaction or CRM evidence exceeds the QuickBooks amount or scope                                    |
| `matched_conflict`                 | Accounting relationships overlap or materially contradict linked transaction or CRM evidence                 |
| `excluded`                         | The QuickBooks record has been excluded from active reconciliation                                           |

A single large QuickBooks record linked to several smaller transactions is not automatically mixed or conflicted. It is valid when the mapping is explicit, complete, and non-overlapping.

## 7.2 QuickBooks actions

| Action                                               | Availability                                                           |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| Match to CRM gift                                    | Raw, enriched, or partially matched                                    |
| Match to transaction                                 | Raw, enriched, or partially matched                                    |
| Confirm proposed match                               | A match has been proposed                                              |
| Group QuickBooks records                             | Two or more records jointly represent one accounting event             |
| Split QuickBooks record into reconciliation units    | One accounting record needs to be represented as several subcomponents |
| Unmatch from CRM gift                                | Any QuickBooks record with a CRM relationship                          |
| Unmatch from transaction                             | Any QuickBooks record with a transaction relationship                  |
| Exclude                                              | Any non-excluded state                                                 |
| Un-exclude                                           | Excluded                                                               |
| Fill out QuickBooks from CRM or transaction evidence | CRM is complete and a target QuickBooks record has been identified     |
| View QuickBooks record                               | Any QuickBooks record                                                  |

## 7.3 QuickBooks permissions

Only a user with a finance-team role may make changes to QuickBooks records or accounting relationships.

This includes:

* Creating or changing QuickBooks coding
* Populating QuickBooks fields from CRM
* Grouping or splitting QuickBooks reconciliation records
* Confirming accounting relationships
* Removing or replacing confirmed accounting relationships
* Excluding or un-excluding QuickBooks records
* Writing changes back to QuickBooks

Non-finance users may:

* View QuickBooks evidence
* View proposed mappings
* Supply or correct CRM information
* Request finance review
* Propose a match, where the workflow supports proposals

They may not apply accounting changes.

## 7.4 Filling out QuickBooks from CRM

`Fill out QuickBooks from CRM` is a cross-column write action that uses CRM-resident information to populate or propose accounting fields.

It is available only when:

* The CRM gift is complete
* A target QuickBooks record has been identified
* The acting user is a finance-team member
* The destination fields are applicable to the record
* Existing conflicting QuickBooks values are reviewed rather than silently overwritten

Potentially propagated information includes:

* Donor or customer identity
* Recipient entity, project, or school
* Restrictions
* Memo or description
* Funding source
* Processor or intermediary
* Fees
* Reporting obligations
* Other accounting classification fields

The action should present a reviewable comparison before writing conflicting or previously populated values.

---

# 8. CRM Column

The CRM column represents gifts, donors, allocations, coding forms, grant letters, and related fundraising information.

CRM state should describe both:

1. The completeness of the CRM card itself
2. The completeness of its relationships to other evidence

This mirrors the transaction and QuickBooks columns.

## 8.1 CRM card states

| State                      | Meaning                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `missing`                  | No CRM gift exists for the relevant evidence                                                                              |
| `unmatched_incomplete`     | A CRM gift exists, is not linked to external evidence, and does not satisfy a canonical CRM-completeness path             |
| `unmatched_complete`       | A CRM gift exists, is not linked to transaction or accounting evidence, and satisfies a canonical CRM-completeness path   |
| `matched_incomplete`       | A CRM gift is linked to external evidence but does not satisfy a canonical CRM-completeness path                          |
| `matched_complete`         | A CRM gift is linked and satisfies a canonical CRM-completeness path                                                      |
| `partial_gift_surplus`     | Some CRM gift amount is not covered by linked live transaction or accounting evidence                                     |
| `partial_external_surplus` | Linked live transaction or accounting evidence exceeds the CRM gift amount or scope                                       |
| `mixed`                    | Competing unit- and bundle-level CRM representations overlap                                                              |
| `conflict`                 | CRM information materially contradicts Donorbox, a completed coding form, a grant letter, or another authoritative record |
| `pledge_link_broken`       | A payment relationship expected from a pledge allocation has been disconnected and requires repair                        |
| `lost`                     | The gift or opportunity is no longer expected to receive payment                                                          |
| `dormant`                  | No current live payment is known, but the opportunity may still result in a future gift                                   |

A CRM card can therefore be complete for its own column while the row’s link status remains `missing`.

For example:

```text
CRM card: unmatched_complete
Row link status: missing
Row information status: accounting_pending
```

### CRM surplus does not establish whether payment occurred

`partial_gift_surplus` means only that some CRM amount is not covered by transaction or accounting evidence currently linked in the system.

It does not establish whether:

* The payment has not occurred
* The payment exists but has not been found
* The payment exists but has not been linked
* The payment will occur later
* The remaining gift amount will never be paid

These are possible explanations, not CRM states.

Multiple charges linked to multiple corresponding gifts are not mixed when they form a consistent unit-grain mapping.

A multi-charge payout linked to one CRM gift is not mixed when it is an intentional and complete bundle-grain representation.

Mixed requires competing or overlapping CRM representations.

## 8.2 CRM actions

| Action                                    | Availability                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| Create gift from scratch                  | CRM gift missing                                                                          |
| View and complete gift                    | Any incomplete CRM state                                                                  |
| Match CRM gift to transaction             | Unmatched or partially matched CRM card                                                   |
| Match CRM gift to QuickBooks evidence     | Unmatched or partially matched CRM card                                                   |
| Confirm proposed match                    | A match has been proposed                                                                 |
| Unmatch CRM gift from transaction         | CRM card has a transaction relationship                                                   |
| Unmatch CRM gift from QuickBooks evidence | CRM card has an accounting relationship                                                   |
| Remove CRM card from row                  | The card was grouped into the row incorrectly or should be separated from the other cards |
| Move CRM card to a new row                | The card belongs in the workbench but not with the current evidence set                   |
| Group allocations into one gift           | Multiple records represent one intended CRM gift                                          |
| Split allocations into separate gifts     | One gift contains allocations that belong to distinct gifts                               |
| Compare source documents                  | Conflict involving Donorbox, coding form, grant letter, or another source                 |
| Mark gift lost                            | No live payment is linked and the donor relationship is no longer expected to close       |
| Mark gift dormant                         | No live payment is linked but future payment remains possible                             |
| Repair pledge allocation link             | Pledge link broken                                                                        |
| Unmatch payment from pledge               | An incorrect pledge-payment relationship exists                                           |
| Fill out QuickBooks from gift             | CRM complete, target QuickBooks record identified, and user is a finance-team member      |

`Remove CRM card from row` and `Move CRM card to a new row` are relationship actions. They do not delete or archive the CRM gift.

---

# 9. Actions and Directionality

Matching and unmatching are cross-column relationship actions.

They should be modeled once at the relationship level, even though they may be initiated from any participating card.

For example, these UI actions all operate on the same underlying relationship:

* “Match transaction to CRM gift”
* “Match CRM gift to transaction”
* “Link this gift”
* “Attach this charge”

Likewise:

* “Unmatch transaction from CRM gift”
* “Unmatch CRM gift from transaction”
* “Remove this gift from the row”

may all remove or alter the same underlying link, depending on context.

## 9.1 Relationship actions

Relationship actions create, confirm, change, or remove links between evidence records.

* Match
* Confirm proposed match
* Unmatch
* Replace match
* Group
* Split
* Move a card to another row
* Remove a card from a row
* Repair a broken pledge relationship

The API should expose relationship-centric commands, such as:

```ts
createRelationship(...)
confirmRelationship(...)
removeRelationship(...)
replaceRelationship(...)
moveCardToCluster(...)
```

The UI label may be written from the perspective of the card where the user initiated the action.

## 9.2 Enrichment actions

Enrichment actions add or improve information without changing which cards are related.

* Complete CRM gift
* Complete coding form
* Attach grant letter
* Fill out QuickBooks from CRM
* Add missing restriction information
* Add accounting coding

## 9.3 Disposition actions

Disposition actions change whether evidence or opportunities remain active.

* Exclude or un-exclude evidence
* Mark gift lost
* Mark gift dormant
* Mark transaction refund anticipated

## 9.4 Exception actions

Exception actions resolve inconsistencies or special conditions.

* Clear refund expectation
* Resolve amount mismatch
* Resolve donor or restriction conflict
* Replace an incorrect relationship
* Repair a broken pledge allocation link

---

# 10. Canonical State Shape

The row status should summarize independently derived component states rather than replace them.

```ts
type WorkbenchRowState = {
  linkage: {
    state:
      | "complete"
      | "partial"
      | "mixed"
      | "partial_mixed"
      | "missing";

    accountingToTransaction: CoverageState;
    transactionToCrm: CoverageState;
    accountingToCrm: CoverageState;
  };

  information: {
    state:
      | "audit_ready"
      | "accounting_pending"
      | "incomplete";

    crmComplete: boolean;
    qbComplete: boolean;
  };

  flags: {
    excluded: boolean;
    conflict: boolean;
    attentionRequired: boolean;
  };

  settlementLinkState?: SettlementLinkState;

  qbCards: Array<{
    qbRecordId: string;
    state: QbRecordState;
  }>;

  transactions: Array<{
    transactionId: string;
    state: TransactionState;
    livePayment: boolean;
    refundStatus:
      | "none"
      | "anticipated"
      | "refunded";
  }>;

  crmCards: Array<{
    giftId: string;
    recordComplete: boolean;
    relationshipState:
      | "unmatched"
      | "partial"
      | "matched"
      | "mixed"
      | "conflict";
    satisfiedBy:
      | "donorbox"
      | "completed_coding_form"
      | "donor_allocations_and_supporting_documents"
      | null;
  }>;
};
```

Refund state belongs inside each transaction, not at the row level.

CRM information completeness and CRM relationship completeness are separate. A CRM card may be complete while remaining unmatched.

---

# 11. Completion and Active-Row Rules

A row is link-complete only when:

* All required live evidence is connected
* Amounts reconcile within tolerance
* No required evidence units are uncovered
* No overlapping unit- and bundle-grain representations exist
* No unresolved relationship conflict exists

A row is `audit_ready` only when:

* Every CRM card on the row is complete
* Required accounting information has been documented
* Any required source documentation is present
* The accounting and CRM records are mutually consistent

A CRM-only row:

* Has row link status `missing`
* May have complete or incomplete CRM information
* Does not establish whether payment occurred
* Remains active until supporting evidence is found and linked, or the gift is otherwise resolved

A refunded transaction:

* Does not count as live payment evidence
* Does not itself cause the CRM gift to disappear
* May leave the row with `missing` or `partial` link coverage
* Does not prove that the gift is unpaid
* Does not prove that no replacement payment exists
* Leaves the CRM opportunity active until another transaction is linked or the gift is marked lost or dormant

A row may enter Completed only when its canonical row state is complete. Lens membership, counts, displayed status, and available actions must all derive from the same state.
