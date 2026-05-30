---
name: Verifying mockup-sandbox component previews
description: How to reliably screenshot /__mockup/preview components; external_url gives false-blank negatives
---

# Verifying mockup-sandbox previews

To verify a component rendered at `/__mockup/preview/<folder>/<Component>`, use the
`screenshot` tool with `type=app_preview`, `artifact_dir_name=mockup-sandbox`,
`path=/preview/<folder>/<Component>`. It routes through the localhost:80 proxy AND
returns the browser console log.

**Why:** The `type=external_url` screenshot method (hits the public `.replit.dev`
preview URL via the external screenshot service) can return a fully blank/white image
even when the component renders fine. This produced a long false "IndividualRecord is
broken / blank" chase — the component was always fine; only the external_url capture
failed. A zero-import sentinel `<div>` also showed blank via external_url but rendered
instantly via app_preview.

**How to apply:** Never conclude a mockup-sandbox component is broken from an
external_url screenshot alone. Confirm with app_preview, which also surfaces real
runtime errors in its browser-log output. The preview entry has no React error
boundary, so a true render-time throw blanks the tree — but you'll see it in the
app_preview browser log, not a red overlay.
