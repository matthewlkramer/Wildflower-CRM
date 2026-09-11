# Grant-lead future suppressions

This migration adds durable reviewer-created rules that prevent future email
ingests from recreating a grant lead for either one named program or an entire
funder. It does not infer rules from existing archived leads and does not
delete any data.

## Apply

Run `0240_grant_lead_future_suppressions.sql` in one transaction in each
environment before deploying the corresponding application code.

## Verify

Confirm `grant_lead_suppressions` exists with its unique constraint and that
archiving a test lead with each future scope creates one rule. Reprocessing a
matching email should create neither a lead nor a sighting.

## Rollback

Roll back the application first, then drop `grant_lead_suppressions`. The
table contains reviewer decisions, so export it before rollback if those
decisions should be preserved.
