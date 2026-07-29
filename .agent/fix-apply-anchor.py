from pathlib import Path

path = Path(".agent/apply-workbench-usability.py")
text = path.read_text(encoding="utf-8")
old = """api = replace_once(
    api,
    '''          payment_unit_id: string;
          unit_id: string;''',
    '''          payment_unit_id: string;
          bank_deposit_id: string;
          component_amount: string;
          unit_id: string;''',
    "component unlink details type",
)"""
new = """api = replace_once(
    api,
    '''          id: string;
          source: string;
          payment_unit_id: string;
          unit_id: string;
          minted: boolean;
          has_counted_application: boolean;''',
    '''          id: string;
          source: string;
          payment_unit_id: string;
          bank_deposit_id: string;
          component_amount: string;
          unit_id: string;
          minted: boolean;
          has_counted_application: boolean;''',
    "component unlink details type",
)"""
if old not in text:
    raise SystemExit("ambiguous component type anchor not found")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
