-- 0131: Fold the retired coding-form reference columns into gifts.tags.
--
-- The coding-form apply step no longer stamps dedicated codingForm* columns on
-- gifts — reference attributes are appended to the free-text `tags` field as
-- prefixed entries ("Circle: …", "Series: …", "Notes: …", "Memo: …"). This
-- migration folds any existing column values into tags the same way, then
-- NULLs the columns. The physical columns are retained (deprecated, never
-- written/read/returned) so schema push does not propose a drop.
--
-- Dedupe rule (must match tagsContain in codingForms.ts): an entry is only
-- appended when the RAW value does not already appear anywhere in tags,
-- case-insensitively.
--
-- Idempotent: the WHERE clause only matches rows with a non-null coding-form
-- column, and every matched row has all four columns set to NULL — a second
-- run touches zero rows.
--
-- Apply (human-run, after Publish ships the code):
--   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0131_fold_coding_form_refs_into_tags.sql
-- (No BEGIN/COMMIT here — the -1 flag wraps the file in a transaction.)

UPDATE gifts_and_payments AS g
SET
  tags = NULLIF(
    concat_ws(
      ', ',
      NULLIF(btrim(coalesce(g.tags, '')), ''),
      CASE
        WHEN btrim(coalesce(g.coding_form_circle, '')) <> ''
         AND position(lower(btrim(g.coding_form_circle)) IN lower(coalesce(g.tags, ''))) = 0
        THEN 'Circle: ' || btrim(g.coding_form_circle)
      END,
      CASE
        WHEN btrim(coalesce(g.coding_form_series, '')) <> ''
         AND position(lower(btrim(g.coding_form_series)) IN lower(coalesce(g.tags, ''))) = 0
        THEN 'Series: ' || btrim(g.coding_form_series)
      END,
      CASE
        WHEN btrim(coalesce(g.coding_form_additional_notes, '')) <> ''
         AND position(lower(btrim(g.coding_form_additional_notes)) IN lower(coalesce(g.tags, ''))) = 0
        THEN 'Notes: ' || btrim(g.coding_form_additional_notes)
      END,
      CASE
        WHEN btrim(coalesce(g.coding_form_memo, '')) <> ''
         AND position(lower(btrim(g.coding_form_memo)) IN lower(coalesce(g.tags, ''))) = 0
        THEN 'Memo: ' || btrim(g.coding_form_memo)
      END
    ),
    ''
  ),
  coding_form_circle = NULL,
  coding_form_series = NULL,
  coding_form_additional_notes = NULL,
  coding_form_memo = NULL,
  updated_at = now()
WHERE g.coding_form_circle IS NOT NULL
   OR g.coding_form_series IS NOT NULL
   OR g.coding_form_additional_notes IS NOT NULL
   OR g.coding_form_memo IS NOT NULL;

-- Verify (expect 0):
--   SELECT count(*) FROM gifts_and_payments
--   WHERE coding_form_circle IS NOT NULL OR coding_form_series IS NOT NULL
--      OR coding_form_additional_notes IS NOT NULL OR coding_form_memo IS NOT NULL;
