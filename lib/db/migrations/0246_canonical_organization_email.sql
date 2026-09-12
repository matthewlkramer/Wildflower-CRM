-- Run in a transaction with psql -1, after reviewing the companion runbook.
-- No address may be lost or reassigned to a different owner.
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'organizations' AND column_name = 'org_email') THEN
    RETURN;
  END IF;
  LOCK TABLE organizations, emails IN SHARE ROW EXCLUSIVE MODE;
  IF EXISTS (
    SELECT 1 FROM organizations o WHERE NULLIF(trim(o.org_email), '') IS NOT NULL
    AND (trim(o.org_email) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      OR EXISTS (SELECT 1 FROM emails e WHERE lower(e.email) = lower(trim(o.org_email))
        AND e.organization_id IS DISTINCT FROM o.id)
      OR EXISTS (SELECT 1 FROM organizations other WHERE other.id <> o.id
        AND lower(trim(other.org_email)) = lower(trim(o.org_email))))
  ) THEN
    RAISE EXCEPTION 'Organization email preflight failed: malformed address or conflicting owners. Review conflicts before cutover; no values changed.';
  END IF;

  INSERT INTO emails (id, email, organization_id, validity, is_preferred, created_at, updated_at)
  SELECT 'org_email_0246_' || o.id, trim(o.org_email), o.id, 'unknown',
    NOT EXISTS (SELECT 1 FROM emails e WHERE e.organization_id = o.id AND e.is_preferred),
    now(), now()
  FROM organizations o
  WHERE NULLIF(trim(o.org_email), '') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM emails e WHERE lower(e.email) = lower(trim(o.org_email)));

  INSERT INTO audit_log (id, action, entity_type, entity_id, summary, changes, metadata)
  SELECT 'org_email_0246_' || o.id, 'field_consolidated', 'organization', o.id,
    'Moved organization email authority to Contact info',
    jsonb_build_array(jsonb_build_object('field', 'orgEmail', 'from', o.org_email, 'to', e.email)),
    jsonb_build_object('migration', '0246', 'emailId', e.id)
  FROM organizations o JOIN emails e ON lower(e.email) = lower(trim(o.org_email)) AND e.organization_id = o.id
  ON CONFLICT (id) DO NOTHING;

  IF EXISTS (SELECT 1 FROM organizations o WHERE NULLIF(trim(o.org_email), '') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM emails e WHERE e.organization_id = o.id AND lower(e.email) = lower(trim(o.org_email)))) THEN
    RAISE EXCEPTION 'Organization email postflight failed; rolling back.';
  END IF;
  ALTER TABLE organizations DROP COLUMN org_email;
END
$migration$;
