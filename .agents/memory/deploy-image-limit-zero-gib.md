---
name: Deploy "image size is over the limit of 0 GiB"
description: How to recognize the transient Replit deploy image-size-limit glitch vs a real oversized image.
---

# Deploy error: "image size is over the limit of 0 GiB"

A publish can fail at the very last step (after build succeeds, devDeps are pruned,
and all layers push) with `error: image size is over the limit of 0 GiB`.

**The `0 GiB` limit is the tell.** When the limit reads literally `0 GiB` and a
recent build of the same code succeeded, this is a Replit **platform-side transient
glitch** (the deployer read the size allowance as 0), NOT an oversized image you
introduced.

**Why:** Observed a failed build whose image was unchanged from a build ~2h earlier
that succeeded on the same machine slug. The deploy image is built from the
**committed git tree** + a fresh prod `pnpm install` + built `dist` — NOT the
working-dir snapshot (that's why `.gitignore`-ing PII CSVs is sufficient protection,
and why a git-ignored 558 MB `tools/*/node_modules` never enters the image). This
repo's entire tracked tree is only ~50 MB, so a genuine GiB-scale overflow is
implausible.

**How to apply / diagnose:**
- Pull build logs with the deployment skill's `getDeploymentBuild({buildId})` /
  `listDeploymentBuilds()` (code_execution callbacks).
- Compare the **"Created Repl layer"** push duration across the failed build and the
  last successful one. Near-identical timing ⇒ image size did NOT change ⇒ the limit
  value is the anomaly, not the image.
- Fix = **retry Publish first** (transient glitches clear). If it persists with the
  same `0 GiB` limit, it's a platform/quota issue → tell the user to retry and, if
  still failing, contact Replit support with the failed build ID. Do NOT chase
  image-size reductions (deleting node_modules, trimming assets) — they don't help
  against a `0` limit and the git-based image is already small.
