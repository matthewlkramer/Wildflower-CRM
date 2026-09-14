-- Gmail stores the message identity in the URL fragment. The prior
-- canonicalizer removed it, collapsing distinct newsletter messages.
UPDATE "wildflower_update_sources"
SET "normalized_url" = CASE
  WHEN "url" ~* '^https?://mail\.google\.com/mail(/|$)'
    THEN replace(trim("url"), '/#', '#')
  ELSE "normalized_url"
END
WHERE "url" ~* '^https?://mail\.google\.com/mail(/|$)';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "wildflower_update_sources"
    GROUP BY "item_id", "normalized_url"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate (item_id, normalized_url) rows remain after Gmail source repair';
  END IF;
END $$;