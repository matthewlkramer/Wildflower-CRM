---
name: Donor-intent restriction policy (owner rules)
description: Four owner-ratified rules that override coding-form/source-text restriction answers when coding allocation restrictions — Yield/Arthur Rock never restricted, BWF always, hubs geo-restricted, Donorbox designations authoritative.
---

# Donor-intent restriction policy (owner rules, ratified 2026-07-18)

When coding allocation restrictions from any source (coding forms, Donorbox,
QB memos, manual entry), these rules OVERRIDE what the form/source text says:

1. **Yield gift + anything from Arthur Rock: NEVER donor_restricted** — always
   unrestricted or Wildflower-designated, whatever the paperwork says.
2. **Anything for BWF / Black Wildflowers Fund: usage axis donor_restricted**,
   even when the answer says gen-ops/unrestricted ("intended for BWF but not
   restricted" still restricts).
3. **Anything for a regional hub: geo-restricted to its region** regardless of
   the form — append the hub region to the allocation and latch the regional
   axis to donor_restricted. Only mappable hub circles count
   (`classifyCircle`/HUB_REGION_ALIASES: CO, PR, MN, Mid-Atlantic, DC);
   "Hub: Radicle" is a cohort, not a geography — no region write.
4. **Donorbox designations are authoritative** — they come straight from the
   donor (e.g. "growth in DC" → DC geo; hurricane relief / MN immigrant
   families → restricted to those projects).

**Why:** the owner ratified these after the 0133 bulk queue resolution; the
generic negation heuristic ("not restricted" answers don't latch) mis-coded BWF
and hub money as unrestricted. Outside rules 1–4 the negation heuristic still
holds.

**How to apply:** any restriction-coding judgment (bulk SQL, review-queue
confirms, applyRow decision payloads) must check these rules BEFORE trusting
the restriction answer text. CAVEAT — stamped decisions only act if the
cross-check is emitted at apply time: applyRow gates every decision through
`actionableAttributes` (applicable && !blockedReason). `usageRestriction` is
applicable only when live restriction text exists — an AI `junkFields` flag on
`restrictionLanguage` suppresses it and the stamped 'apply' is SILENTLY
dropped (row still exits as 'applied'); un-junk the field first when a rule-2
flip must act. `regionalRestriction` needs a mappable circle AND a resolvable
single allocation; unmappable circles no-op safely. Stray decision keys never
break the endpoint (counted as nothing_to_apply).
