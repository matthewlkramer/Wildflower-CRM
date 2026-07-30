from pathlib import Path

path = Path("lib/api-spec/openapi.yaml")
text = path.read_text(encoding="utf-8")
old = '        "409": { description: The pathway is circular, unavailable, or otherwise unsafe. }\n'
new = '        "409": { description: "The pathway is circular, unavailable, or otherwise unsafe." }\n'
if text.count(old) != 1:
    raise SystemExit(f"OpenAPI 409 description: expected one occurrence, found {text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("preferred donor OpenAPI response description fixed")
