---
name: Inline-edit trigger sites (detail pages)
description: Where detail-page edit pencils/triggers live; the 4 that bypass the shared EditTriggerRow.
---

Detail-page field editing uses several read-mode "trigger" rows. Most funnel
through the shared `EditTriggerRow` in `components/inline-edit.tsx` (used by
InlineEditText/Currency/Date/Boolean/Select → user-picker, and region-picker).

**But four trigger rows do NOT use EditTriggerRow** and replicate the
div + ghost-Button + Pencil pattern by hand:
- `InlineEditTextarea` non-editing block (own block so multi-line notes don't truncate)
- entity-picker: two blocks (person-picker + donor-picker)
- multi-select-picker: one block (chips + pencil)

**Why it matters:** any cross-cutting change to inline-edit affordances must hit
all five sites or behavior drifts. Shared bits are exported from inline-edit:
`INLINE_EDIT_GROUP`, `EDIT_PENCIL_REVEAL`, `EDIT_VALUE_CLICKABLE`,
`makeEditValueClick`. Grep `button-edit-` / `Pencil` to find them.

**Scope guard:** list/table pages (gifts/individuals/opportunities/funding-entities/
pipeline) import only `useUserNameMap`/`useRegionNameMap` from those modules — never
the trigger components — so inline-edit changes don't touch list/table views.
