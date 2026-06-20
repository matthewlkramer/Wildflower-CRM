---
name: Shared multi-outcome handler gating
description: When one handler/body serves multiple outcomes, gate behavior on the explicit outcome flag, never on a shared body field's mere presence.
---

When a single request handler (or a shared helper) serves several outcomes through
ONE request body, gate each outcome's behavior on the explicit outcome/option flag —
never on whether some shared body field happens to be present/truthy.

**Why:** The reconciler approve route (`approve.ts`, `mintGiftFromEvidence`) shares
one body across `create_gift`, `create_gift_from_opportunity`,
`convert_to_pledge_and_first_payment`, and `link_existing_gift`. The body type allows
`opportunityId` on EVERY outcome. The helper originally read
`const opportunityId = body.opportunityId ?? null` globally, then branched on the
truthiness of that id (lock the opp, derive donor from it, set `paymentOnPledgeId`,
re-derive post-commit). A plain `create_gift` carrying a stray/stale `opportunityId`
from the UI would therefore silently HIJACK the donor (derive from the opp instead of
the validated body donor — a Donor-XOR-relevant data-integrity bug), attach the
payment to the wrong pledge, and re-derive an unrelated opportunity. Architect flagged
it as severe.

**How to apply:** Derive the gating value from the outcome option, e.g.
`const opportunityId = opts.requireOpportunity ? (body.opportunityId ?? null) : null;`
so a field that is irrelevant to the current outcome is forced inert (ignored or
explicitly rejected), not honored. Add a regression test that sends the irrelevant
field on the wrong outcome and asserts it is ignored. General rule: a permissive
shared body is fine, but every branch must consume only the fields its outcome
actually owns.
