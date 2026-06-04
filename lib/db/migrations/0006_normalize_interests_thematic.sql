-- Migration 0006: Normalize the interests_thematic tag set
--
-- interests_thematic is a free-form text[] on BOTH organizations and people.
-- Over time it accumulated legacy snake_case values and casing duplicates that
-- pointed at the same concept. This collapses every raw variant onto a single
-- canonical Title-case label, deduplicating within each row's array.
--
-- Unambiguous casing/format folds:
--   montessori                       -> Montessori
--   ed_tech                          -> Ed tech
--   ece_policy                       -> ECE policy
--   intentional_diversity            -> Intentional diversity
--   workforce                        -> Workforce development
--   youth                            -> Youth
--   women                            -> Women
--   data_accountability             -> Data accountability   (kept SEPARATE from
--                                       "Data-driven instruction")
-- Confirmed concept merges:
--   social_emotional                 -> Socio-emotional learning
--   racial_equity + Racial Justice   -> Racial equity & justice
--   family_engagement                -> Parent engagement
--   microschools_teacher_leadership  -> Microschools
--
-- Idempotent: each UPDATE only touches rows that still contain a raw value
-- (the `&&` overlap gate), and the canonical labels are never themselves raw
-- keys, so a second run matches zero rows. array_agg(DISTINCT ...) dedupes the
-- merge collisions (e.g. a row carrying both racial_equity and Racial Justice).
--
--   psql "$DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f 0006_normalize_interests_thematic.sql

BEGIN;

-- organizations
WITH m(raw, canon) AS (
  VALUES
    ('montessori', 'Montessori'),
    ('ed_tech', 'Ed tech'),
    ('microschools_teacher_leadership', 'Microschools'),
    ('intentional_diversity', 'Intentional diversity'),
    ('ece_policy', 'ECE policy'),
    ('racial_equity', 'Racial equity & justice'),
    ('Racial Justice', 'Racial equity & justice'),
    ('social_emotional', 'Socio-emotional learning'),
    ('data_accountability', 'Data accountability'),
    ('family_engagement', 'Parent engagement'),
    ('workforce', 'Workforce development'),
    ('youth', 'Youth'),
    ('women', 'Women')
)
UPDATE organizations t
SET interests_thematic = s.arr
FROM (
  SELECT t2.id, array_agg(DISTINCT COALESCE(m.canon, e.val)) AS arr
  FROM organizations t2
  CROSS JOIN LATERAL unnest(t2.interests_thematic) AS e(val)
  LEFT JOIN m ON m.raw = e.val
  WHERE t2.interests_thematic && ARRAY[
    'montessori','ed_tech','microschools_teacher_leadership',
    'intentional_diversity','ece_policy','racial_equity','Racial Justice',
    'social_emotional','data_accountability','family_engagement',
    'workforce','youth','women'
  ]::text[]
  GROUP BY t2.id
) s
WHERE t.id = s.id;

-- people
WITH m(raw, canon) AS (
  VALUES
    ('montessori', 'Montessori'),
    ('ed_tech', 'Ed tech'),
    ('microschools_teacher_leadership', 'Microschools'),
    ('intentional_diversity', 'Intentional diversity'),
    ('ece_policy', 'ECE policy'),
    ('racial_equity', 'Racial equity & justice'),
    ('Racial Justice', 'Racial equity & justice'),
    ('social_emotional', 'Socio-emotional learning'),
    ('data_accountability', 'Data accountability'),
    ('family_engagement', 'Parent engagement'),
    ('workforce', 'Workforce development'),
    ('youth', 'Youth'),
    ('women', 'Women')
)
UPDATE people t
SET interests_thematic = s.arr
FROM (
  SELECT t2.id, array_agg(DISTINCT COALESCE(m.canon, e.val)) AS arr
  FROM people t2
  CROSS JOIN LATERAL unnest(t2.interests_thematic) AS e(val)
  LEFT JOIN m ON m.raw = e.val
  WHERE t2.interests_thematic && ARRAY[
    'montessori','ed_tech','microschools_teacher_leadership',
    'intentional_diversity','ece_policy','racial_equity','Racial Justice',
    'social_emotional','data_accountability','family_engagement',
    'workforce','youth','women'
  ]::text[]
  GROUP BY t2.id
) s
WHERE t.id = s.id;

-- Verification (should return ZERO rows after this migration):
--   SELECT v, count(*) FROM (
--     SELECT unnest(interests_thematic) v FROM organizations
--     UNION ALL SELECT unnest(interests_thematic) v FROM people
--   ) x
--   WHERE v = ANY(ARRAY[
--     'montessori','ed_tech','microschools_teacher_leadership',
--     'intentional_diversity','ece_policy','racial_equity','Racial Justice',
--     'social_emotional','data_accountability','family_engagement',
--     'workforce','youth','women']::text[])
--   GROUP BY v;

COMMIT;
