-- Migration 0239: deterministic media-ingest fingerprints.
--
-- Additive and non-destructive: existing rows are fingerprinted so future
-- ingests can reuse them, but no historical row is dismissed or relinked.

ALTER TABLE media_mentions
  ADD COLUMN IF NOT EXISTS canonical_url text;

ALTER TABLE media_mentions
  ADD COLUMN IF NOT EXISTS headline_fingerprint text;

UPDATE media_mentions
SET canonical_url = split_part(lower(trim(url)), '#', 1)
WHERE canonical_url IS NULL;

UPDATE media_mentions
SET headline_fingerprint = md5(
  lower(regexp_replace(coalesce(title, ''), '[^a-zA-Z0-9]+', '', 'g'))
)
WHERE headline_fingerprint IS NULL
  AND length(regexp_replace(coalesce(title, ''), '[^a-zA-Z0-9]+', '', 'g')) >= 12;

CREATE INDEX IF NOT EXISTS media_mentions_canonical_url_idx
  ON media_mentions(canonical_url);

CREATE INDEX IF NOT EXISTS media_mentions_headline_fingerprint_idx
  ON media_mentions(headline_fingerprint, publication_date);
