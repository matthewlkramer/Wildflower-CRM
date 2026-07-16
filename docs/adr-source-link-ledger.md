# ADR: One source-link ledger for evidence↔evidence claims

**Status:** Proposed (2026-07-16) · **Owner:** reconciliation
**Companion:** [`reconciliation-design.md`](reconciliation-design.md) — the
ratified two-plane target state. This ADR fills the one gap that design left
open: *where do evidence↔evidence claims live?*

## 1. Context — the claim plane is still pointer-shaped

The ratified design gives each of the two link planes one durable home:

- **Plane 1 (batch↔batch):** `settlement_links` (payout ↔ QB deposit lump) —
  shipped.
- **Plane 2 (unit↔gift):** the `payment_applications` cash-application ledger —
  shipped (sole gift-link record; all six evidence→gift pointers retired).

But a third kind of relationship — **unit-grain evidence ↔ evidence claims**
("these two rows in two money systems are the same money", with NO gift
involved) — still lives as scattered pointer columns:

| Pointer (today) | Claim it records | Cardinality enforced today |
| --- | --- | --- |
| `stripe_staged_charges.linked_qb_staged_payment_id` | CONFIRMED charge ↔ individually-booked QB row tie | app-level 409s only (`chargeQbTie.ts`); **no unique index** on the QB target |
| `stripe_staged_charges.proposed_qb_staged_payment_id` | system-PROPOSED tie awaiting review | none (SET NULL on QB delete) |
| `stripe_staged_charges.linked_fee_qb_staged_payment_id` | charge ↔ the negative QB "Stripe fee" sibling row | none (partial index for lookup only) |
| `donorbox_donations.linked_qb_staged_payment_id` | donation ↔ QB row counterpart | none |
| `donorbox_donations.linked_stripe_charge_id` | donation ↔ Stripe charge counterpart | none |

Pointer-column problems, all already paid for once on the gift plane:

1. **No lifecycle.** Proposed vs confirmed needs a second column
   (`proposed_qb_staged_payment_id`) or is unrepresentable (fee links,
   donorbox links have no proposed state at all).
2. **No provenance.** Who/when/why lives in adjacent prose columns or not at
   all; the charge-tie supersede has to stamp a *string prefix marker*
   (`payment_applications.note = 'charge_tie_supersede:<qbId>'`) to remember
   which ledger rows it minted — `note.startsWith()` as a data model.
3. **No DB-enforced cardinality.** "One confirmed tie per QB row" is a 409 in
   one code path; a second writer (backfill, script, future route) can silently
   double-claim.
4. **Asymmetric queries.** "What claims this QB row?" requires knowing every
   pointer column that might point at it (the derived-status builders embed
   this list today).

## 2. Decision

Create **one `source_links` table** for unit-grain evidence↔evidence claims,
sharing the `settlement_links` vocabulary (`lifecycle`, `provenance`,
`confirmed_by_user_id`/`confirmed_at`, `note`). `settlement_links` itself stays
purpose-built for the batch plane (per design Decision 1 — two planes, two
tables); this ADR does NOT fold it in.

| Column | Meaning |
| --- | --- |
| `id` | pk |
| `link_type` | `charge_qb_tie` \| `charge_fee_row` \| `donorbox_qb` \| `donorbox_charge` |
| `stripe_charge_id` | FK → `stripe_staged_charges`, nullable |
| `qb_staged_payment_id` | FK → `staged_payments`, nullable |
| `donorbox_donation_id` | FK → `donorbox_donations`, nullable |
| `lifecycle` | `proposed` \| `confirmed` (collapses the two-pointer proposed/linked dance into one row's state) |
| `provenance` | `system` \| `system_confirmed` \| `human` |
| `confirmed_by_user_id` / `confirmed_at` | who/when |
| `note` | optional human text — never machine-parsed |

Per-`link_type` CHECKs pin exactly which two FK columns are non-NULL
(`charge_qb_tie` ⇒ charge + qb; `charge_fee_row` ⇒ charge + qb;
`donorbox_qb` ⇒ donorbox + qb; `donorbox_charge` ⇒ donorbox + charge).

**Cardinality becomes DB-enforced** (today's app-409s stay as the friendly
error; the indexes make them unbeatable):

- `UNIQUE (stripe_charge_id) WHERE link_type = 'charge_qb_tie' AND lifecycle = 'confirmed'` — a charge has at most one confirmed QB tie.
- `UNIQUE (qb_staged_payment_id) WHERE link_type = 'charge_qb_tie' AND lifecycle = 'confirmed'` — a QB row is claimed by at most one confirmed tie (**new protection — no index guards this today**).
- `UNIQUE (stripe_charge_id) WHERE link_type = 'charge_fee_row'` — one fee-row link per charge; many charges MAY share one QB fee lump row (no uniqueness on the QB side, matching today's semantics).
- `UNIQUE (donorbox_donation_id) WHERE link_type = 'donorbox_qb'` and `… = 'donorbox_charge'` — one counterpart of each kind per donation.

**Claim ≠ status stays law.** The derived-status invariant hardened in
`derivedStatus.ts` carries over verbatim: a `source_links` row is a CLAIM
(blocks re-picking, feeds eligibility filters); status evidence for the QB row
remains *the tied charge's own counted ledger row* (the booked-tie predicate).
`match_confirmed` must never derive from raw linkage — the builders' claim/
evidence split (`qbChargeTieLinkExistsText` vs `qbChargeTieBookedExistsText`)
simply re-points its EXISTS at `source_links` at cutover, and the
rendering/execution parity tests pin the split across the migration.

**Structured supersession provenance** (retiring `note.startsWith(...)`):
tie-derived moved ledger rows get a first-class `match_method` value instead of
a note marker — extend the existing `payment_applications.match_method` enum
with `charge_tie_supersede` (an enum value, NOT a new column). Which tie minted
the row is then a pure join: the moved row's charge has exactly one confirmed
`charge_qb_tie` link (unique index above), and revert deletes exactly the
`match_method = 'charge_tie_supersede'` counted rows on that charge —
same discrimination as today's marker, no string parsing, and `note` returns to
being human text. The demoted-QB-row discriminator (corroborating + amount
kept) is unchanged.

**Explicitly rejected alternatives:**

- *More pointer columns* (e.g. a `superseded_by_link_id` on
  `payment_applications`, or keeping `proposed_*` pointers) — prohibited;
  pointers are the disease this ADR treats.
- *Separate structured-provenance columns* (e.g. `supersede_source_qb_id`) —
  prohibited; provenance rides in the ledger/link rows that already exist.
- *One mega-table absorbing `settlement_links`* — re-litigates ratified
  Decision 1 for no query we actually run; revisit only if a third batch-grain
  link type ever appears.

## 3. Migration plan (prod-safe, phased — mirrors §7 discipline)

Each phase is independently shippable and reversible; prod data changes are
human-applied idempotent SQL files per invariant #7.

1. **Additive schema, gated by a double-claim pre-flight.** FIRST run a
   read-only pre-flight SELECT against prod that reports any existing
   double-claims (two pointers claiming the same row) for human resolution
   (expected: zero — the 409s have guarded confirmed ties since 0129). Only
   then create `source_links` + enums + CHECKs + the partial unique indexes;
   extend `match_method` with `charge_tie_supersede`. Ships via Publish; no
   reads, no writes. *(Risk: none — additive; the pre-flight guarantees the
   unique indexes cannot conflict with real data.)*
2. **Backfill.** Idempotent migration file translates every non-NULL pointer
   into a `source_links` row (`linked_*` ⇒ `confirmed`, `proposed_*` ⇒
   `proposed`; provenance from the adjacent audit columns where present,
   else `system`) and rewrites `note = 'charge_tie_supersede:<qbId>'` rows to
   `match_method = 'charge_tie_supersede'` (note text preserved). `ON CONFLICT
   DO NOTHING` on the unique indexes is a belt-and-suspenders guard only — the
   phase-1 pre-flight already proved zero double-claims, so a conflict here
   means new drift and the backfill's affected-row count must be reconciled
   against the pointer count, not trusted on clean exit.
3. **Dual-write.** Every pointer write path (`chargeQbTie.ts` confirm/revert/
   propose, fee-row claim, donorbox link routes, sync workers) also upserts the
   `source_links` row in the same transaction. Pointers remain the read source.
   A drift check (script) diffs pointers vs links nightly in dev.
4. **Read cutover.** Flip readers in dependency order, each behind its scoped
   check + suites: derived-status builders (claim predicates only — the parity
   tests must not change expectations), pick-list blockers/409s, workbench +
   bundle-anchor projections, supersede/revert discrimination, donorbox
   reconcile. The parity integration test runs against BOTH shapes during this
   phase (seed pointer + link, assert identical derivations).
5. **Stop-write + deprecate.** Pointer writes cease; columns become
   `@deprecated` **and stay physical** (repo convention: never approve the
   interactive-push drop; scrub from every response projection — the
   deprecated-column-leak rule). `proposed_qb_staged_payment_id` is the one
   likely full-drop candidate later (pure workflow state, no history value),
   via the deprecated-column-drop-audit playbook.
6. **(Later, optional) physical drops** per the drop-audit playbook, one
   column per Publish, after a full quiet cycle.

## 4. Consequences

- The derived-status builders' claim predicates collapse to one EXISTS shape
  over `source_links` regardless of source pair; adding the next money source
  (e.g. a second processor) is a new `link_type` value, not a new column on an
  evidence table.
- The QB-side tie target gains real uniqueness for the first time.
- `chargeTieSupersede.ts` sheds its string-marker protocol; revert logic
  becomes enum-filtered.
- Cost: one more table in the reconciliation join graph, and a dual-write
  window to operate. Both bounded and already precedented by the
  `payment_applications` cutover.
