---
status: runbook
last_verified: 2026-09-15
---

# Flodesk engagement bridge through ChatGPT

This is the temporary production path for Flodesk campaign engagement while
Flodesk's official MCP is available as a ChatGPT app but not as a reusable
server-to-server URL. WFCRM remains the source of truth for cadence, exact-email
matching, monotonic evidence merges, watermarks, and run completion.

## Safety boundary

- The WFCRM MCP endpoint requires its own long random bearer secret stored as
  `FLODESK_CHATGPT_MCP_AUTH_TOKEN` in Replit and in the ChatGPT custom-app
  connection. Never put the token in a task title, prompt, repository, log, or
  chat message.
- The MCP app exposes only three narrowly scoped newsletter-engagement tools.
  It cannot read or mutate people, preferences, gifts, or other CRM data.
- Recipient identity links only by exact normalized address already present in
  `emails`. Unmatched evidence remains unmatched; no person is created.
- Page imports are monotonic and idempotent. A campaign watermark advances only
  on the page explicitly marked final. A failed partial run therefore remains
  due and safely replays later.
- Flodesk click data includes bot/security-scanner activity and is directional
  engagement evidence, not proof of a human action.

## Publish and connect

1. Publish the reviewed WFCRM release and confirm `/api/healthz` is healthy.
2. Generate a dedicated high-entropy token. Save the same value as the Replit
   secret `FLODESK_CHATGPT_MCP_AUTH_TOKEN` and as bearer authentication for the
   custom ChatGPT app. Do not reuse any other CRM or Flodesk credential.
3. In ChatGPT web, enable Developer Mode and create a custom MCP app named
   **Wildflower CRM Newsletter Import** with this endpoint:

   ```text
   https://wfcrm.replit.app/api/integrations/flodesk-chatgpt/mcp
   ```

4. Fetch the tool definitions and verify that only these tools appear:
   `plan_flodesk_engagement_sync`, `import_flodesk_recipient_page`, and
   `complete_flodesk_engagement_sync`.
5. Enable the official Flodesk app for the same ChatGPT account/workspace. Full
   custom-MCP write actions currently require an eligible ChatGPT Business,
   Enterprise, or Edu workspace; confirm the app action can be persistently
   approved before scheduling it.

## One-run proof

In a new ChatGPT Work conversation, select both the Flodesk app and the
Wildflower CRM Newsletter Import app. Run the task instructions below once
manually. Confirm:

- Flodesk `rank_emails` returns parseable sent campaigns;
- WFCRM planning returns only due campaigns;
- every Flodesk recipient cursor page is imported in order;
- only the last page is sent with `finalPage=true`;
- the completion tool reports aggregate counts;
- the CRM Newsletter page shows the refreshed campaign and exact-email links.

Do not schedule the task if either app asks for approval on every write or if
the one-run evidence is incomplete.

## Scheduled task

Schedule one cloud ChatGPT Work task daily at 5:30 AM America/Chicago, after the
CRM's 3:00–5:00 AM subscriber-reconciliation window. Keep the
schedule simple; WFCRM, not ChatGPT, applies the daily-for-14-days and weekly
thereafter rule.

Use these task instructions:

```text
Synchronize Flodesk newsletter engagement into Wildflower CRM.

1. Use Flodesk rank_emails to retrieve the complete set of sent email campaigns.
2. Normalize each campaign to providerCampaignId, subject, sentAt, previewUrl,
   openRate, and clickRate, then call the CRM planning tool once with the full
   campaign list.
3. For every campaign returned as due, call Flodesk list_email_recipients and
   retrieve every cursor page. Immediately import each complete page into the
   CRM in cursor order. Map each recipient to email, firstName, lastName,
   deliveredAt, opened, lastOpenedAt, totalOpens, clicked, lastClickedAt,
   totalClicks, and clickedLinks. Set finalPage=false while a next cursor exists
   and true only for the page after which no next cursor exists. If a campaign
   has zero recipients, send one empty final page.
4. After every due campaign has completed successfully, call the CRM completion
   tool with campaignsChecked, campaignsRefreshed, and the sum of imported
   recipient records.

Never create or modify CRM people or newsletter preferences. Never omit or
summarize recipient rows. If any tool call or page fails, do not call the
completion tool; report which campaign and page failed and stop. If the run
succeeds, stay quiet unless unmatched records increased or another result needs
human review.
```

## Retirement condition

When Flodesk provides a supported server-to-server MCP connection URL, configure
`FLODESK_MCP_URL`, run the direct one-shot verification, confirm fresh campaign
watermarks in WFCRM, then pause and explicitly retire this ChatGPT scheduled
task. Never leave both paths actively refreshing the same campaigns by design.
