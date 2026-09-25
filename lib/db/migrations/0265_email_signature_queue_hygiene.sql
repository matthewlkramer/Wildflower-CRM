-- 0265: remove stale and deterministically invalid signature-update proposals.
-- Data-only and idempotent. Accepted/rejected/ignored history is untouched.
-- Apply with:
-- psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0265_email_signature_queue_hygiene.sql

-- Messages before the 24-month release cutoff are historical evidence, not a
-- current contact update. Preserve the rows as audit history and remove them
-- from the pending queue.
UPDATE email_proposals
SET
  status = 'ignored',
  resolved_at = COALESCE(resolved_at, now()),
  reviewer_note = left(
    COALESCE(NULLIF(reviewer_note, '') || ' | ', '') ||
    'Auto-suppressed: source email predates the 24-month contact-evidence window',
    500
  ),
  updated_at = now()
WHERE kind = 'signature_update'
  AND status = 'pending'
  AND email_sent_at IS NOT NULL
  AND email_sent_at < TIMESTAMPTZ '2024-09-25 00:00:00+00'
  AND COALESCE(reviewer_note, '') NOT LIKE '%predates the 24-month contact-evidence window%';

-- Strip actions that are provably invalid without an AI judgment:
--   * a phone already belongs to the target person;
--   * a phone belongs to the mailbox owner, not the correspondent;
--   * the action's own reason says the phone is already on file; or
--   * a role exactly matches the mailbox owner's current title + organization.
WITH affected AS (
  SELECT
    p.id,
    p.proposed_actions AS original,
    COALESCE(
      (
        SELECT jsonb_agg(action ORDER BY ordinality)
        FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(p.proposed_actions) = 'array'
            THEN p.proposed_actions ELSE '[]'::jsonb END
        ) WITH ORDINALITY AS proposed(action, ordinality)
        WHERE NOT (
          (
            action->>'type' = 'set_phone'
            AND (
              action->>'reason' ~* '(already (on file|matches)|matches .*on file|same .*on file)'
              OR EXISTS (
                SELECT 1
                FROM phone_numbers target_phone
                WHERE target_phone.person_id = action->>'personId'
                  AND length(regexp_replace(target_phone.phone_number, '\D', '', 'g')) >= 10
                  AND right(regexp_replace(target_phone.phone_number, '\D', '', 'g'), 10) =
                      right(regexp_replace(action->>'phoneNumber', '\D', '', 'g'), 10)
              )
              OR EXISTS (
                SELECT 1
                FROM users mailbox_user
                JOIN emails owner_email
                  ON lower(owner_email.email) = lower(mailbox_user.email)
                 AND owner_email.person_id IS NOT NULL
                JOIN phone_numbers owner_phone
                  ON owner_phone.person_id = owner_email.person_id
                WHERE mailbox_user.id = p.mailbox_user_id
                  AND owner_email.person_id IS DISTINCT FROM p.target_person_id
                  AND length(regexp_replace(owner_phone.phone_number, '\D', '', 'g')) >= 10
                  AND right(regexp_replace(owner_phone.phone_number, '\D', '', 'g'), 10) =
                      right(regexp_replace(action->>'phoneNumber', '\D', '', 'g'), 10)
              )
            )
          )
          OR (
            action->>'type' IN ('create_per', 'create_org_with_per', 'create_funder_with_per', 'update_per_title')
            AND action->>'externalTitleOrRole' IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM users mailbox_user
              JOIN emails owner_email
                ON lower(owner_email.email) = lower(mailbox_user.email)
               AND owner_email.person_id IS NOT NULL
              JOIN people_entity_roles owner_role
                ON owner_role.person_id = owner_email.person_id
               AND owner_role.current = 'current'
              LEFT JOIN organizations owner_org
                ON owner_org.id = owner_role.organization_id
              WHERE mailbox_user.id = p.mailbox_user_id
                AND owner_email.person_id IS DISTINCT FROM p.target_person_id
                AND lower(trim(COALESCE(owner_role.external_title_or_role, ''))) =
                    lower(trim(action->>'externalTitleOrRole'))
                AND lower(trim(COALESCE(owner_org.name, ''))) = lower(trim(COALESCE(
                  action->>'entityName',
                  action->>'organizationName',
                  action->>'funderName',
                  action->>'roleEntityName',
                  ''
                )))
            )
          )
        )
      ),
      '[]'::jsonb
    ) AS cleaned
  FROM email_proposals p
  WHERE p.kind = 'signature_update'
    AND p.status = 'pending'
    AND jsonb_typeof(p.proposed_actions) = 'array'
), changed AS (
  SELECT id, cleaned
  FROM affected
  WHERE cleaned IS DISTINCT FROM original
)
UPDATE email_proposals p
SET
  proposed_actions = changed.cleaned,
  status = CASE WHEN changed.cleaned = '[]'::jsonb THEN 'ignored' ELSE p.status END,
  resolved_at = CASE
    WHEN changed.cleaned = '[]'::jsonb THEN COALESCE(p.resolved_at, now())
    ELSE p.resolved_at
  END,
  reviewer_note = CASE
    WHEN changed.cleaned = '[]'::jsonb THEN left(
      COALESCE(NULLIF(p.reviewer_note, '') || ' | ', '') ||
      'Auto-suppressed: duplicate or mailbox-owner contact data',
      500
    )
    ELSE p.reviewer_note
  END,
  updated_at = now()
FROM changed
WHERE p.id = changed.id;

DO $$
DECLARE
  stale_pending integer;
  duplicate_owner_phones integer;
BEGIN
  SELECT count(*) INTO stale_pending
  FROM email_proposals
  WHERE kind = 'signature_update'
    AND status = 'pending'
    AND email_sent_at < TIMESTAMPTZ '2024-09-25 00:00:00+00';

  SELECT count(*) INTO duplicate_owner_phones
  FROM email_proposals p
  WHERE p.kind = 'signature_update'
    AND p.status = 'pending'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(p.proposed_actions) = 'array'
          THEN p.proposed_actions ELSE '[]'::jsonb END
      ) action
      WHERE action->>'type' = 'set_phone'
        AND (
          EXISTS (
            SELECT 1 FROM phone_numbers target_phone
            WHERE target_phone.person_id = action->>'personId'
              AND right(regexp_replace(target_phone.phone_number, '\D', '', 'g'), 10) =
                  right(regexp_replace(action->>'phoneNumber', '\D', '', 'g'), 10)
          )
          OR EXISTS (
            SELECT 1
            FROM users mailbox_user
            JOIN emails owner_email ON lower(owner_email.email) = lower(mailbox_user.email)
            JOIN phone_numbers owner_phone ON owner_phone.person_id = owner_email.person_id
            WHERE mailbox_user.id = p.mailbox_user_id
              AND owner_email.person_id IS DISTINCT FROM p.target_person_id
              AND right(regexp_replace(owner_phone.phone_number, '\D', '', 'g'), 10) =
                  right(regexp_replace(action->>'phoneNumber', '\D', '', 'g'), 10)
          )
        )
    );

  RAISE NOTICE '0265: stale pending signature proposals = % (expect 0)', stale_pending;
  RAISE NOTICE '0265: duplicate/owner phone proposals = % (expect 0)', duplicate_owner_phones;
END $$;
