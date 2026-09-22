-- 0260: new Broadstreet payments are lease-guaranty income, not gifts.
-- Depends on 0259 and is intentionally a separate transaction because it uses
-- the enum value added there.

INSERT INTO quickbooks_handling_rules
  (id, name, enabled, priority, action, exclusion_reason, donation_guard, match_logic, conditions)
VALUES
  ('seed_broadstreet_lease_guaranty', 'Broadstreet lease guaranty payments',
   true, 25, 'exclude', 'lease_guaranty', false, 'any',
   '[{"field":"any_text","mode":"contains","value":"broadstreet"}]'::jsonb)
ON CONFLICT (id) DO NOTHING;
