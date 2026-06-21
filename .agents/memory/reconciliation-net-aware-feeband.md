---
name: Reconciliation net-aware fee-band window
description: When the processor NET is known, the [net,gross] amount window must be returned authoritatively — not added as an extra accept-path on top of the legacy heuristic band.
---

# Reconciliation net-aware fee-band window

`amountWithinFeeBand(evidence, gift, evidenceNet?)` (the shared amount check used
by BOTH the reconciliation graph blocker and the approve consistency gate) has two
regimes:

- **Net known** (a Stripe charge backs the money): the gift is the same money ONLY
  inside `[min(net,gross)-0.01, max(net,gross)+0.01]`. Return that window result
  **directly** — the only legitimate gap is gross-vs-net, a processor fee apart.
- **Net absent/invalid** (QB-only): fall back to the legacy asymmetric heuristic
  `gift in [evidence-0.01, evidence*1.1+1]`.

**Why:** the requirement is a *pure* gross-vs-net difference auto-resolves (Approve
with no override; gift stamped to GROSS + single allocation rescaled), but a REAL
discrepancy — crucially a gift **above** gross — must still require an explicit
override reason. The first attempt added the net/gross window as an extra
`if (inWindow) return true;` and then **fell through** to the legacy band, so a gift
above gross but within `gross*1.1+1` (e.g. gross $100 / net $96.80 / gift $105)
silently passed with no override. A processor fee can only LOWER the recorded
amount, never raise it, so above-gross is never fee-explained.

**How to apply:**
- Keep the graph blocker and the approve gate calling the SAME helper (single
  source of truth); approve passes `evidenceNetAmount = charge ? charge.netAmount
  : null` so they stay in lockstep.
- The override reason waives ONLY the amount band — never donor XOR / archived /
  opportunity-donor-mismatch / Stripe-linkage issues.
- When extending a "plausible same-money" predicate with a tighter exact rule,
  make the exact rule REPLACE the heuristic in its regime; don't leave the looser
  band reachable as a fallthrough.
