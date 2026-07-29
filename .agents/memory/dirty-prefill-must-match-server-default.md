---
name: Dirty-tracking prefill must equal the server default
description: Override dialogs that send only user-touched fields must prefill exactly the server's default value — display fallbacks silently drop overrides.
---

# Dirty-tracking prefill must equal the server default

Rule: in a dialog that sends only *changed* fields as overrides (untouched ⇒
server keeps its evidence-derived default), every prefilled input must show
exactly the value the server would use when the field is omitted. If the
server default is "no value", the input must be blank.

**Why:** a display-only fallback (e.g. showing the deposit date when the
staged payment has no received date) creates two silent bugs: (1) the UI shows
a value the server will not use, and (2) a user who deliberately re-picks the
displayed value produces `input === prefill`, is classified as "untouched",
and the intended override is dropped.

**How to apply:** when building or reviewing any evidence-prefilled override
dialog (e.g. the deposits-workbench "Create standalone gift…" flow), derive
each prefill from the same source the server's mint/default logic reads, with
no cosmetic fallbacks; keep the "blank keeps the evidence value" hint literally
true. Related design fact: Stripe charge anchors can only link *existing*
gifts (no QB record ⇒ no approve path), so pledge/opportunity outcomes are
disabled with a visible reason per the label-not-hide rule.
