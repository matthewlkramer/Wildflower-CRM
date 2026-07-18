---
name: Coding-form import (staging queue)
description: Invariants for the one-time donation coding-form import — effective-value layering, AI reinterpretation limits, record-first matching, grant-letter targeting.
---

# Coding-form import invariants

- **Effective-value layering**: every downstream read (cross-checks, applyRow,
  serialization) goes through the `codingFormEffective.ts` accessors, which
  resolve `AI ?? parsed ?? raw`. Never read a raw column directly in matching or
  apply logic — the AI layer would silently be skipped.
  **Why:** cross-check display and applyRow must stay in lockstep; a raw read in
  one of them shows the reviewer one value and writes another.
- **AI may only normalize/suppress, never map.** The AI payload can fix donor
  names, re-parse the address blob, reinterpret the report answer, and flag junk
  fields (closed `AI_JUNKABLE_FIELDS` list). Circle→region/entity mapping is
  deterministic (`classifyCircle`, closed alias map) — the AI is prompted and
  schema-constrained away from it. Keep it that way; a hallucinated region write
  is worse than a missed one.
- **AI failure is non-destructive**: a model/validation failure records
  `aiError` and leaves the prior payload untouched; success clears `aiError`.
  Bulk default fills gaps only (`aiInterpretation IS NULL`); per-row always
  re-runs. Invalid stored payloads serialize as null (same degradation as the
  effective accessors) — the UI never sees an unvalidated blob.
- **Record-first matching**: gifts/pledges are matched donor-agnostically first;
  the donor is INHERITED from the picked record (candidate gift responses carry
  the three donor XOR FKs for this). Gift-candidate date window uses the gift's
  own date OR its counted QB payment date (via payment_applications →
  staged_payments.date_received), whichever is closer.
- **Non-donation coding form ⇒ exclude its staged QB row too.** User rule: when a
  coding-form row is skipped as not-a-donation (refund, reimbursement, school fee),
  the matching `staged_payments` row must also be excluded from the reconciliation
  queue (same exclusion semantics as the exclude route: `exclusion_reason` +
  `classification_source='manual'`, guarded on derived-pending). Most are already
  auto-excluded — check before adding writes.
  **Why:** otherwise the same non-donation money lingers as reviewable in two queues.
- **Confirm ≠ status change.** `match_confirmed_at` stamps leave
  `status='pending'`; only applyRow flips to `applied`. Bulk-resolution SQL
  verification counts must expect confirmed rows to still count as pending.
- **Grant letters go opportunity-else-gift**: attach to the matched
  opportunity when one exists, else the matched gift. API field names
  `oppExistingUrl`/`oppExistingFilename` were kept for compatibility but mean
  "the target's letter". Bulk pull attempts ready+failed, skips
  na/no_match/imported, and NEVER replaces (conflict stays per-row with
  replace=true).
