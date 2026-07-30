---
name: List search tokenization semantics
description: Which list `search` params tokenize on whitespace vs match one contiguous phrase; why multi-word donor names fail on phrase-match endpoints.
---

# List `search` tokenization

**Rule:** GET /gifts-and-payments `search` is tokenized — split on whitespace, each word ORs across gift name / org name / household name / person display name / payment-intermediary, words ANDed. Tokenized matching is a strict superset of the old contiguous `%phrase%` behavior, so switching an endpoint never loses previously-matching rows.

**Why:** A user searched "nancy peretsman bob scully" in the workbench gift-search dialog and got nothing because the household is named "Nancy Peretsman **and** Bob Scully" — the contiguous `%phrase%` ILIKE could not skip the "and" connector. Household/couple names routinely contain connectors ("and", "&") that users omit when typing.

**How to apply:** If a multi-word search "finds nothing" for a record that clearly exists, check whether that endpoint still does contiguous-phrase ILIKE — most other list endpoints' `search` params still do. Fix by tokenizing the same way (see the search block in `giftsAndPayments.ts` and `gift-search-tokenized.integration.test.ts` for the pattern). Known shared quirk left as-is everywhere: `%` and `_` in user input are not escaped (match-breadth only, fully parameterized so no injection); if escaping is ever added, do it consistently across all search endpoints.
