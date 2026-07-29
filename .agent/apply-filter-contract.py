from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one occurrence, found {count}")
    return text.replace(old, new, 1)


spec_path = Path("lib/api-spec/openapi.yaml")
spec = spec_path.read_text(encoding="utf-8")
spec = replace_once(
    spec,
    '''      summary: List unclaimed non-Stripe payment units for a deposit remainder.
      description: Finance/admin review only. Returns check, direct ACH, wire, and other payment units that are not already attached to a bank deposit component. Results can be narrowed by amount and source text.
      parameters:
        - { name: bankDepositId, in: path, required: true, schema: { type: string } }
        - { name: amount, in: query, schema: { type: string }, description: "Target amount in major units; results are ordered by proximity." }
        - { name: q, in: query, schema: { type: string }, description: "Optional text over the source staged-payment payer or memo and the payment-unit id." }
        - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 25 } }''',
    '''      summary: List eligible non-Stripe payment units for a deposit remainder.
      description: Finance/admin review only. Returns check, direct ACH, wire, and other payment units, including units already attached to this or another bank deposit. Results can be searched broadly and optionally filtered by exact amount and received date.
      parameters:
        - { name: bankDepositId, in: path, required: true, schema: { type: string } }
        - { name: amount, in: query, schema: { type: string }, description: "Target amount in major units; results are ordered by proximity but not filtered by proximity." }
        - { name: q, in: query, schema: { type: string }, description: "Optional text over payer, memo, amount, date, source label, or payment-unit id." }
        - { name: filterAmount, in: query, schema: { type: string }, description: "Optional exact payment-unit amount in major units." }
        - { name: filterDate, in: query, schema: { type: string, format: date }, description: "Optional exact payment-unit received date." }
        - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 25 } }''',
    "candidate payment API contract",
)
spec_path.write_text(spec, encoding="utf-8")

route_path = Path("artifacts/api-server/src/routes/reconciliation/workbenchDeposits.ts")
route = route_path.read_text(encoding="utf-8")
route = replace_once(
    route,
    '''    const rawFilterAmount =
      typeof req.query.filterAmount === "string"
        ? req.query.filterAmount.trim()
        : "";''',
    '''    const rawFilterAmount = query.filterAmount?.trim() ?? "";''',
    "typed amount filter",
)
route = replace_once(
    route,
    '''    const filterDate =
      typeof req.query.filterDate === "string" && req.query.filterDate.trim()
        ? req.query.filterDate.trim()
        : null;''',
    '''    const filterDate = query.filterDate?.trim() || null;''',
    "typed date filter",
)
route_path.write_text(route, encoding="utf-8")

page_path = Path("artifacts/wildflower-crm/src/pages/reconciliation-deposits.tsx")
page = page_path.read_text(encoding="utf-8")
cast = '''      limit: 100,
    } as any,'''
if page.count(cast) != 1:
    raise SystemExit(f"hook query cast: expected one occurrence, found {page.count(cast)}")
page = page.replace(cast, '''      limit: 100,
    },''', 1)
cast_nested = '''            limit: 100,
          } as any,'''
if page.count(cast_nested) != 1:
    raise SystemExit(
        f"query-key cast: expected one occurrence, found {page.count(cast_nested)}"
    )
page = page.replace(cast_nested, '''            limit: 100,
          },''', 1)
page_path.write_text(page, encoding="utf-8")

print("candidate payment filters added to API contract")
