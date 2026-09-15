---
name: Vite component labels and JSX generics
description: Preview-only parse failures caused by Replit's development component-label transform.
---

Avoid explicit generic arguments on JSX component tags when TypeScript can infer
the type from props.

**Why:** The development component-label transform can insert metadata attributes
between a component name and its generic argument. The original source passes
TypeScript, but Vite then receives invalid transformed JSX and shows a parse-error
overlay.

**How to apply:** If the preview reports an unexpected token on a valid tag shaped
like `Component<Type>`, remove the explicit JSX generic and rely on typed props for
inference. Confirm with both the package typecheck and a fresh preview restart.