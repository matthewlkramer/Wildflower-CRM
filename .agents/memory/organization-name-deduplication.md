---
name: Conservative organization-name deduplication
description: Guardrail for email-intelligence organization creation and stale-action acceptance.
---

# Conservative organization-name deduplication

Organization reuse in email intelligence may only treat case, diacritics,
punctuation, repeated whitespace, and one leading `the` as presentation-only
differences. It must evaluate the complete set of primary and historical
organization names before it decides there is exactly one equivalent record.

**Why:** SQL substring prefilters can miss Unicode-equivalent names or hide a
second equivalent record behind a result cap, turning a safe "link one match"
rule into either a duplicate or an arbitrary link.

**How to apply:** use the shared canonical comparison for both suggestion
reconciliation and acceptance-time rechecks. If scale later needs indexing,
the indexed representation must exactly mirror the shared normalization and
still preserve complete ambiguity detection.