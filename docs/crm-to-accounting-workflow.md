---
status: ratified
last_verified: 2026-09-12
---

# CRM-to-accounting workflow

## Decision

Donation coding forms are historical source material, not a continuing intake
system. New gifts are coded once in the CRM. The accounting export is derived
from those CRM records and is the handoff to Finance. The historical coding-form
tables remain temporarily only to support the reviewed correction project and
are removed after that project is verified.

## Current versus target workflow

| Step | Historical workflow | CRM-native workflow |
| --- | --- | --- |
| Donor intent is learned | Development completes a separate coding form. | Development records the opportunity and its planned allocations in the CRM. |
| Governing evidence arrives | Links and files may be repeated in the form. | Grant letter/designation evidence is attached to the opportunity or gift; the exact governing sentence is copied to the allocation's **Restriction language (verbatim)** field. |
| Restriction is classified | Form answers are interpreted later. | Development selects each allocation's regional, purpose/other, and time restriction axes and records region/project/spending-period details. |
| Reporting obligation is recorded | A form answer says whether reporting is required. | Development marks **Donor reporting required** on the opportunity and creates every known Reporting Deadline task. |
| Gift/payment is recorded | Accounting and Development reconcile form, processor, and gift rows. | Reconciliation creates or links the gift and preserves its payment evidence. Gift allocations are the authoritative record of where the received money belongs. |
| Coding is prepared | Staff transcribe a coding-form result into a spreadsheet. | **Export for QB** derives the same 19 accounting columns from the CRM. |
| Review and posting | Finance resolves questions in the spreadsheet and enters QuickBooks by hand. | Finance previews the export, resolves every blocker in the CRM, downloads the CSV, and enters or imports it into QuickBooks. |
| Later automation | Not applicable. | The same validated export payload is submitted to QuickBooks; Finance approves the prepared posting before it becomes final. |

## Sources of truth

- Gift header: donor, received date, gift amount, memo/description, title or
  reference number, source-record link, and payment provenance.
- Gift allocations: allocation amount, fiscal year, recipient entity, intended
  use/project/region, spending period, restriction axes, and exact governing
  restriction language.
- Opportunity: donor reporting required, grant letter, commitment, and payment
  schedule.
- Reporting Deadline tasks: each required report and due date.
- Tax/thank-you acknowledgement attachment: the durable acknowledgement file
  retained in the CRM's acknowledgement attachment field. It is stewardship and
  tax-compliance evidence, not restriction evidence and not an accounting-coding
  input.
- QuickBooks: authoritative record of what was posted. Differences between CRM
  coding and linked QuickBooks coding must be reviewed, never silently overwritten.

## Roles

### Development / fundraising

- Owns donor intent and the governing source evidence.
- Records planned scope on the opportunity and actual scope on gift allocations.
- Copies exact donor language rather than an AI summary into the verbatim field.
- Marks whether reporting is required and records each deadline.
- Corrects CRM blockers that depend on donor knowledge.

### Reconciliation staff

- Links payment evidence to the correct donor, opportunity, and gift.
- Confirms received amount/date and ensures allocation amounts equal the gift.
- Does not invent missing restrictions, dates, or donor intent.

### Finance

- Reviews the accounting preview and any CRM/QuickBooks disagreement.
- Requires all blockers to be resolved in the CRM before export.
- Downloads and posts the validated export during the manual phase.
- In the automated phase, approves the prepared QuickBooks transaction and
  records the resulting accounting evidence.

### CRM administrator

- Maintains entity-to-account/location/class derivation rules.
- Reviews data-quality queues and audit logs.
- Runs reviewed, repeatable historical corrections; does not use the retired
  coding-form importer for live work.

## Safeguards

1. Every gift must have exactly one donor, an amount, a received date, and at
   least one allocation.
2. Every allocation must have an amount, entity, fiscal year, and intended use;
   project allocations must identify the project.
3. Every donor-restricted allocation must carry the exact governing source
   language and the gift/linked opportunity must retain a grant letter or source
   record link.
4. Every new opportunity requires an explicit yes/no reporting decision. An
   unreviewed historical answer blocks export; a yes also requires a Reporting
   Deadline task.
5. Allocation totals must equal the gift amount.
6. The accounting page is a preview while any blocker, derivation question, or
   CRM/QuickBooks coding disagreement exists. CSV download is disabled.
7. Corrections are made in the source CRM record, not patched into the exported
   file. Re-running the export must reproduce the corrected result.
8. Historical corrections use previewable, idempotent migrations with an audit
   trail and post-run verification.
9. Future QuickBooks automation must preserve the same preview and Finance
   approval gate; it may replace manual entry, not the controls.

## Historical coding-form retirement gate

Do not drop the historical staging table until the open cleanup project is
complete: the 29 decision rows are answered; the 58 applied and 46 skipped rows
are audited; approved corrections are applied; attachments and reporting dates
are verified; and the corrected CRM-to-accounting export is checked. The live
navigation, page, and recurring FY27 ingest are retired now so no new dependency
can be created.
