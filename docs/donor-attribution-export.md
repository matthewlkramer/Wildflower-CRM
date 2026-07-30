
# Donor attribution production export

This export is for reviewing preferred donor pathways, household groupings, DAF
usage, and inconsistent donor attribution against production-shaped data.

It deliberately excludes contact information, free-text notes, raw source
payloads, and credentials. The resulting compressed JSON still contains donor
names and financial amounts, so treat it as confidential.

Run from the repository root with a read-only production database credential:

```bash
DATABASE_URL="$PROD_READ_ONLY_DATABASE_URL" \
DONOR_ATTRIBUTION_EXPORT_PATH="./donor-attribution-production.json.gz" \
pnpm --filter @workspace/scripts run export:donor-attribution
```

The file is written with mode `0600`. Upload only the resulting `.json.gz` file
to the private analysis conversation. Delete the local copy when the review is
complete.
