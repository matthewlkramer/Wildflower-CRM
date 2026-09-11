# Media-ingest precision and retroactive review

Migration `0239_media_ingest_precision_and_retro_review.sql` is additive. It
does not dismiss, merge, or relink any historical media mention.

## Production audit captured 2026-09-10

The read-only audit covered every `media_mentions` row:

- 11,877 total rows; all 11,877 came from GDELT; zero were dismissed.
- 824 exact same-day normalized-headline clusters contain 3,508 rows.
- Those clusters contain 2,684 excess syndicated/reposted copies.
- The largest exact-headline cluster contains 30 rows.
- The rows carry 1,150 person links and 10,999 organization links.

Scott Cook has 36 linked rows. Headline review classified 27 as Australian
crime/police coverage, six as Intuit stock-trading articles that do not concern
him personally, and two as unrelated community-college dinner reposts. The one
remaining Montana dark-money article may concern him and requires a human
decision. The recommended production action is therefore to remove 35 links
and review the final article before changing it.

## Apply and verify

After the application release is approved, apply this migration before
deploying the corresponding application code:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f lib/db/migrations/0239_media_ingest_precision_and_retro_review.sql
```

Verify all rows were covered:

```sql
SELECT
  count(*) AS total,
  count(*) FILTER (WHERE canonical_url IS NOT NULL) AS canonicalized,
  count(*) FILTER (
    WHERE title IS NOT NULL AND headline_fingerprint IS NOT NULL
  ) AS fingerprinted
FROM media_mentions;
```

## Human-gated cleanup

Do not bulk-delete by headline alone. First export the candidate clusters and
retain one canonical row per genuinely identical story, merging its person and
organization IDs before dismissing excess rows. Review every person link; the
new ingest requires a person's exact full name in the headline, but older rows
were created from body-text matches and remain less trustworthy.

For Scott Cook, preview the exact target set before any update:

```sql
SELECT m.id, m.publication_date, m.publication_name, m.title, m.url
FROM people p
JOIN media_mentions m ON p.id = ANY(m.person_ids)
WHERE p.full_name = 'Scott Cook'
ORDER BY m.publication_date DESC NULLS LAST;
```

After a human confirms the 35 false/noisy rows, remove only Scott Cook's ID
from those rows' `person_ids`. Do not dismiss a row that is still relevant to
another linked person or organization. Record the reviewed IDs and decision in
the release evidence before applying the update.
