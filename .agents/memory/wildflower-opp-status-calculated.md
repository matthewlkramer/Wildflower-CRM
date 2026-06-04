---
name: opportunity status is fully calculated
description: opportunity_status is derived server-side; the only user-settable override is loss_type — never write status directly.
---

# Opportunity status is fully calculated

`opportunities_and_pledges.status` is **never user-settable**. It is derived
server-side from `loss_type` + `stage` + payments. The only override a user can
set is `loss_type` (enum `dormant | lost | null`).

Derivation order (see `deriveOppFields`/`applyDerivedOppFields` in
`artifacts/api-server/src/lib/pledgeStage.ts`):

1. `loss_type` set → `status = loss_type`
2. else fully paid (paid ≥ awarded) or `stage = cash_in` → `cash_in`
3. else `stage ∈ (verbal_commitment, written_commitment)` → `pledge`
4. else → `open`

**Why:** status used to be a free editable field that drifted from the funnel.
Splitting it means the funnel value is always trustworthy and only the
loss/dormant decision is a human judgement call.

**How to apply:**
- API: `status` is `readOnly` in the OpenAPI spec and stripped from
  Create/Update/BulkPatch bodies. Write paths accept `lossType` only; status is
  recomputed via `applyDerivedOppFields`. Bulk `allowedFields` uses `lossType`.
- `canonicalWinProbability` keys dormant/lost off the *calculated* status.
- Frontend: opportunity-detail renders Status as a read-only badge
  (`data-testid="text-opp-status"`) plus a separate editable "Loss type" control
  (`testIdBase="opp-loss-type"`, allowNull). `bulk-fields.ts` exposes `lossType`,
  not `status`. List pages still filter/badge on the calculated `status` column
  (fine — the column still exists).
- The `opportunity_status` enum still contains `dormant`/`lost` (NOT removed) —
  the calculated status can legitimately be those values.
- `saveLossType` defaults `actualCompletionDate` to today **only when null** (does
  not overwrite an existing close date).
