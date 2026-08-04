from pathlib import Path

path = Path("artifacts/api-server/src/routes/reconciliation/workbenchDeposits.ts")
text = path.read_text()

old = """                  AND dqc.bank_deposit_id = d.id
                  AND NOT EXISTS ("""
new = """                  AND dqc.bank_deposit_id = d.id
                  AND COALESCE(qsp.funding_source, '') <> 'stripe'
                  AND NOT EXISTS ("""
if old not in text:
    raise SystemExit("Could not find provisional-composition QBO source filter anchor")
text = text.replace(old, new, 1)

old = """              AND gift_dqc.bank_deposit_id = d.id
              AND gift_qsp.exclusion_reason IS NULL"""
new = """              AND gift_dqc.bank_deposit_id = d.id
              AND COALESCE(gift_qsp.funding_source, '') <> 'stripe'
              AND gift_qsp.exclusion_reason IS NULL"""
if old not in text:
    raise SystemExit("Could not find provisional-gift QBO source filter anchor")
text = text.replace(old, new, 1)

path.write_text(text)
