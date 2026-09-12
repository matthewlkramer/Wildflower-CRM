-- Additive evidence model. See 0246_0247_field_simplification_RUNBOOK.md.
CREATE TABLE IF NOT EXISTS newsletter_preference_events (
  id text PRIMARY KEY,
  person_id text NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  occurred_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  source_key text NOT NULL,
  source_url text,
  evidence text NOT NULL,
  metadata jsonb,
  recorded_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT newsletter_preference_type_ck CHECK (event_type IN ('consent_given', 'staff_added', 'staff_removed', 'opted_out', 'legacy_selected', 'legacy_opted_out')),
  CONSTRAINT newsletter_preference_evidence_ck CHECK (length(trim(evidence)) > 0 AND length(trim(source)) > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS newsletter_preference_source_key_uq ON newsletter_preference_events(source_key);
CREATE INDEX IF NOT EXISTS newsletter_preference_person_idx ON newsletter_preference_events(person_id, recorded_at);
CREATE INDEX IF NOT EXISTS newsletter_preference_actor_idx ON newsletter_preference_events(recorded_by_user_id);

-- Freeze old flags as evidence only once, before installing the projection trigger.
-- NULL occurred_at is deliberate: a current flag proves no historical event date.
INSERT INTO newsletter_preference_events (id, person_id, event_type, source, source_key, evidence)
SELECT 'newsletter_0247_selected_' || id, id, 'legacy_selected', 'Legacy CRM', 'legacy:selected:' || id,
  'Newsletter flag was selected at migration. Who selected it and when are unknown; this is not proof of consent.'
FROM people p WHERE p.newsletter AND NOT EXISTS (SELECT 1 FROM newsletter_preference_events e WHERE e.person_id = p.id)
ON CONFLICT (source_key) DO NOTHING;
INSERT INTO newsletter_preference_events (id, person_id, event_type, source, source_key, evidence)
SELECT 'newsletter_0247_optout_' || id, id, 'legacy_opted_out', 'Legacy CRM', 'legacy:optout:' || id,
  'Unsubscribed flag was set at migration. Event date, initiator, and method are unknown.'
FROM people p WHERE p.unsubscribed_to_newsletter
  AND NOT EXISTS (SELECT 1 FROM newsletter_preference_events e WHERE e.person_id = p.id AND e.source <> 'Legacy CRM')
ON CONFLICT (source_key) DO NOTHING;

-- The single state deriver. A staff addition cannot erase an opt-out.
-- Unknown opt-out dates conservatively use first observation for ordering;
-- only affirmative consent with a known later event date can lift suppression.
CREATE OR REPLACE FUNCTION refresh_newsletter_preference(p_person_id text) RETURNS void
LANGUAGE plpgsql AS $fn$
DECLARE selected boolean; opted_out boolean;
BEGIN
  PERFORM 1 FROM people WHERE id = p_person_id FOR UPDATE;
  SELECT COALESCE((SELECT event_type IN ('consent_given', 'staff_added', 'legacy_selected')
    FROM newsletter_preference_events WHERE person_id = p_person_id
      AND event_type IN ('consent_given', 'staff_added', 'staff_removed', 'legacy_selected')
    ORDER BY CASE WHEN event_type = 'legacy_selected' OR (event_type = 'consent_given' AND occurred_at IS NULL) THEN '-infinity'::timestamptz
      ELSE COALESCE(occurred_at, recorded_at) END DESC,
      (event_type = 'staff_removed') DESC, recorded_at DESC, id DESC LIMIT 1), false)
  INTO selected;
  SELECT EXISTS (SELECT 1 FROM newsletter_preference_events opt
    WHERE opt.person_id = p_person_id AND opt.event_type IN ('opted_out', 'legacy_opted_out')
      AND NOT EXISTS (SELECT 1 FROM newsletter_preference_events consent
        WHERE consent.person_id = p_person_id AND consent.event_type = 'consent_given'
          AND consent.occurred_at > COALESCE(opt.occurred_at, opt.recorded_at)))
  INTO opted_out;
  UPDATE people SET newsletter = selected, unsubscribed_to_newsletter = opted_out
    WHERE id = p_person_id AND (newsletter IS DISTINCT FROM selected OR unsubscribed_to_newsletter IS DISTINCT FROM opted_out);
END $fn$;

CREATE OR REPLACE FUNCTION newsletter_preference_changed() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  -- Changing person_id is reserved for the existing audited person-merge service.
  IF TG_OP = 'UPDATE' AND OLD.person_id IS DISTINCT FROM NEW.person_id THEN
    PERFORM refresh_newsletter_preference(OLD.person_id);
  END IF;
  PERFORM refresh_newsletter_preference(NEW.person_id);
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS newsletter_preference_changed_trg ON newsletter_preference_events;
CREATE TRIGGER newsletter_preference_changed_trg AFTER INSERT OR UPDATE OF person_id
  ON newsletter_preference_events FOR EACH ROW EXECUTE FUNCTION newsletter_preference_changed();

COMMENT ON COLUMN people.newsletter IS 'Read-only audience-selection projection from newsletter_preference_events; never proof of consent.';
COMMENT ON COLUMN people.unsubscribed_to_newsletter IS 'Read-only current opt-out projection; lifetime opt-out evidence remains in newsletter_preference_events.';
