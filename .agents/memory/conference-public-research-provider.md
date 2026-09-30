---
name: Conference public research provider
description: Live provider capability and source-grounding lessons for conference research.
---

Treat native Responses `web_search` availability as an unverified capability, even when the Replit OpenAI Responses proxy and credentials are configured. A live development call in September 2026 did not complete a web-search call; direct public-page retrieval followed by AI extraction did work.

**Why:** The homepage of a real event returned six fetched citations but no supported dates for an older edition, while that event's official schedule URL returned correctly cited dates. A successful API response or credential check alone does not prove research produced usable facts.

**How to apply:** Before a production backfill, test one known official, edition-specific page and inspect cited evidence and retry status. Keep extraction grounded in fetched public text, and do not auto-link an email-only person match unless the email was literally verified on that page. Do not bypass private pages or treat an empty supported-result array as fabricated research.

For PDF fixtures and troubleshooting, do not assume syntactically valid PDF text is extractable end-to-end: long unwrapped text extending past the page crop can silently lose its suffix (including an email address).

**Why:** An initial valid one-line PDF fixture placed the email beyond the page bounds; extraction omitted it, correctly preventing source-grounded matching even though the raw bytes contained the email.

**How to apply:** Use realistic wrapped page layouts in tests. When a public PDF produces partial evidence, inspect extracted text rather than trusting raw PDF bytes or filling the missing claim from the model; scanned and otherwise unsupported PDFs should remain visible retryable work.