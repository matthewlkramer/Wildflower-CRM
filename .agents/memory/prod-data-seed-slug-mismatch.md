---
name: Prod data-seed slug/id mismatch silently no-ops
description: Why an id/slug-matched data-seed UPDATE can run "successfully" yet flag the wrong number of rows, and how to verify.
---

A data-seed migration that matches rows by slug/id in a `WHERE id IN (...)`
clause can apply cleanly (no error, COMMIT) while matching **fewer rows than
intended** — because the id list is stale or wrong for the live DB.

Concrete instance: `0059_entities_fiscally_sponsored.sql` targeted importer-era
entity slugs `n_equity` / `n_indigena`, but the live slugs in **both** dev and
prod are `embracing_equity` / `tierra_indigena` (only `rising_tide` matched). The
file ran without error in prod and flagged 1 of 3 entities; the other two stayed
`false`. No error surfaced because `WHERE id IN (...)` matching nothing is a
legal 0-row UPDATE.

**Why:** "the file ran" ≠ "the file did what it intended." `entities`,
`regions`, `fundable_projects`, `fiscal_years` use human-readable slug PKs that
can differ from importer-era names; the seed author guessed the slugs.

**How to apply:** for any id/slug-matched prod data seed, verify by the
**affected-row count / resulting state**, not just clean exit. Read the live
slugs first (`SELECT id,name FROM <table>`), confirm they match the file's `IN`
list, and after applying confirm the expected count is flagged (here: 3
fiscally_sponsored entities, not 1). Prefer matching by a value verified to exist
in the target env; entity slugs are identical across dev and prod here, so there
is no cross-env drift — the file was simply wrong.
