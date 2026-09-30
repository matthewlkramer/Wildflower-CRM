---
name: Conference public research provider
description: Live provider capability and source-grounding lessons for conference research.
---

Treat native Responses `web_search` availability as an unverified capability, even when the Replit OpenAI Responses proxy and credentials are configured. A live development call in September 2026 did not complete a web-search call; direct public-page retrieval followed by AI extraction did work.

**Why:** The homepage of a real event returned six fetched citations but no supported dates for an older edition, while that event's official schedule URL returned correctly cited dates. A successful API response or credential check alone does not prove research produced usable facts.

**How to apply:** Before a production backfill, test one known official, edition-specific page and inspect cited evidence and retry status. Keep extraction grounded in fetched public text, and do not auto-link an email-only person match unless the email was literally verified on that page. Do not bypass private pages or treat an empty supported-result array as fabricated research.