from pathlib import Path

path = Path("lib/api-spec/openapi.yaml")
text = path.read_text(encoding="utf-8")
old = '''      summary: List unclaimed non-Stripe payment units for a deposit remainder.
      description: Finance/admin review only. Returns check, direct ACH, wire, and other payment units that are not already attached to a bank deposit component. Results can be narrowed by amount and source text.
      parameters:
        - { name: bankDepositId, in: path, required: true, schema: { type: string } }
        - { name: amount, in: query, schema: { type: string }, description: "Target amount in major units; results are ordered by proximity." }
        - { name: q, in: query, schema: { type: string }, description: "Optional text over the source staged-payment payer or memo and the payment-unit id." }
        - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 25 } }'''
new = '''      summary: List eligible non-Stripe payment units for a deposit remainder.
      description: Finance/admin review only. Returns check, direct ACH, wire, and other payment units, including units already attached to this or another bank deposit. Results can be searched broadly and optionally filtered by exact amount and received date.
      parameters:
        - { name: bankDepositId, in: path, required: true, schema: { type: string } }
        - { name: amount, in: query, schema: { type: string }, description: "Target amount in major units; results are ordered by proximity but not filtered by proximity." }
        - { name: q, in: query, schema: { type: string }, description: "Optional text over payer, memo, amount, date, source label, or payment-unit id." }
        - { name: filterAmount, in: query, schema: { type: string }, description: "Optional exact payment-unit amount in major units." }
        - { name: filterDate, in: query, schema: { type: string, format: date }, description: "Optional exact payment-unit received date." }
        - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 25 } }'''
count = text.count(old)
if count != 1:
    raise SystemExit(f"candidate payment contract block: expected one occurrence, found {count}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("OpenAPI contract normalized")
