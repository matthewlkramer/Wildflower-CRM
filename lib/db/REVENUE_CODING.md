# Revenue accounting & QuickBooks coding capture

This documents the revenue-coding data the CRM **captures** on gift & pledge
allocations per the CFO's "Revenue Extractor" spec, and how the derived
QuickBooks coding (Object Code / Location / Class) is produced.

> **Scope:** the CRM *captures* coding data and derives a best-effort coding
> snapshot for the accountant to review. It does **not** compute accrual, AR, or
> any GAAP revenue recognition — that stays in QuickBooks / the accounting
> workflow. Anything ambiguous is surfaced as a `codingFlags` entry rather than
> guessed silently.

## Where it lives

- **Derivation lib** — `lib/api-zod/src/revenue-coding.ts` (env-neutral; imported
  by the API server and the browser). Exports `REVENUE_ACCOUNTS` (closed Object
  Code list), `LOCATIONS` (closed Location list), `SEED_ENTITY_CODING_RULES`,
  and `deriveRevenueCoding()`.
- **Tables** — `revenue_accounts` (reference list, lightly editable),
  `entity_coding_rules` (admin-editable per-entity defaults). Both seeded by
  migration `lib/db/migrations/0050_revenue_coding_capture.sql`.
- **Captured columns** — on `gift_allocations` and `pledge_allocations`:
  `restriction_type`, `restriction_evidence`, `purpose_verbatim`,
  `deferred_revenue`, `deferred_revenue_reason`, the derived snapshot
  (`object_code`, `revenue_location`, `revenue_class`, `coding_flags`), and the
  manual overrides (`object_code_override`, `revenue_location_override`,
  `revenue_class_override`). Pledge allocations also carry `contingent`.
- **Admin UI** — Admin → "Revenue coding rules" (per-entity defaults) and the
  derived/override fields under "More details" in the gift & pledge allocation
  editors.
- **Fidelity test** — `artifacts/api-server/src/__tests__/revenue-coding-fidelity.test.ts`
  keeps the code seed constants in lockstep with the migration seed.

## Effective coding

```
effective = override ?? derived_snapshot
```

The derived snapshot is **frozen on write** (stored on each allocation) so the
accounting view is stable. It is re-derived when the parent gift/pledge donor or
type changes (the value is an accounting fact about *that* allocation, not a
live computed view). A manual override always wins over the snapshot.

## Object Code derivation

| Condition                                            | Object Code            | Flag |
| ---------------------------------------------------- | ---------------------- | ---- |
| Gift type `loan_fund_investment` (principal, not revenue) | `null`            | `loan_no_revenue_account` |
| `restriction_type` null / `unclear`                  | `null`                 | `restriction_unclear` |
| `restriction_type` = `na`                            | `null`                 | `restriction_na` |
| Entity rule `force_restricted`, or `restriction_type` = `purpose` | `4100.x` (restricted) | — |
| Otherwise (unrestricted)                             | `4000.x` (unrestricted) | — |

The `.x` suffix is the **payer type**, inferred from the donor (`individual` .1,
`foundation` .2, `corporation` .3, `governmental` .4). When the payer type has to
be assumed, a `payer_type_assumed` flag is added.

Closed Object Code list (`revenue_accounts`): 4000.1–4000.4 (unrestricted),
4100.1–4100.4 (restricted), and the special accounts 4010 (Interest Earned),
4020 (Services – Earned Income), 4099 (Uncategorized Revenue), 4102 (Guaranty
Revenue), 4300 (Intercompany Donation Allocation), 4500 (Loan Fund Servicing).
The special accounts are reference values for manual override — the derivation
only ever picks a 4000.x / 4100.x contribution account.

## Location derivation

Resolved in priority order:

1. **Entity coding rule** `location` (e.g. fiscal sponsees, loan entities).
2. **Charter work** → `Spo- Charter` when the allocation's fundable project is
   `charter_growth` (no dedicated entity exists for charter work).
3. **Region → Hub**, but only for states that have their own Hub:
   `CO → Hub - Colorado`, `DC → Hub - District of Columbia`,
   `MN → Hub - Minnesota`, `PR → Hub - Puerto Rico`.
4. **Default** → `Foundation General` (adds a `location_default` flag).

## Entity coding rules (seed)

| Entity                    | Force restricted | Location                      | Class              |
| ------------------------- | ---------------- | ----------------------------- | ------------------ |
| `black_wildflowers_fund`  | yes              | `Spo- Black Wildflowers Fund` | General Operations |
| `tierra_indigena`         | yes              | `Spo- Tierra Indígena`        | —                  |
| `sunlight_debt`           | no               | `Loans`                       | —                  |
| `sunlight_grants`         | no               | `Loans`                       | —                  |

Fiscal sponsees are always purpose-restricted; the loan-fund entities route to
the `Loans` location. Admins can add/edit/disable rules in the UI; the seed is
applied only for entities that already exist (idempotent `ON CONFLICT DO NOTHING`).

## Class derivation

`revenue_class` (Suggested Class) follows the matching entity coding rule. Charter
work has no entity rule but still carries **General Operations** whenever the
Location derives to `Spo- Charter` (via the `charter_growth` fundable project).
Every other allocation leaves the class unset for manual entry.

## Location gap analysis

Several Locations in the closed list have **no clean CRM signal** to derive them
automatically. They are available as a default on an entity coding rule or as a
manual override, but the derivation will not pick them on its own:

- **`Spo- Charter`** — only derivable via the `charter_growth` fundable project;
  charter work attributed any other way needs a manual Location.
- **`SPO_Seed Fund`** — no entity/region/project signal.
- **`Development`** — no signal (fundraising/dev costs are an accounting concept,
  not a donor-facing attribute).
- **`Foundation Operations`** — no signal; distinct from the `Foundation General`
  default.
- **`School Support`** — no signal.
- **`Radicle Hub`** — no entity/region signal.
- **`Hub - Mid-Atlantic`** — multi-state hub with no single state code, so the
  `STATE_TO_HUB` map can't reach it; needs an entity rule or manual override.

For these, set an `entity_coding_rules.location` default where an entity maps
cleanly, otherwise the fundraiser/accountant sets the Location override on the
allocation. Unresolved Locations fall back to `Foundation General` with a
`location_default` flag so they're easy to find and review.
