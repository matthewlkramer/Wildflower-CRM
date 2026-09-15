# Runbook — Flodesk MCP engagement sync

Migration 0257 adds only nullable identifiers, timestamps, and last-run counters.
It does not rewrite newsletter evidence or subscription preferences.

## Release order

1. Apply the migration to production:

   ```bash
   psql "$PROD_DATABASE_URL" -1 -v ON_ERROR_STOP=1 -f lib/db/migrations/0257_flodesk_mcp_engagement_sync.sql
   ```

2. Publish the application code from the same reviewed release.
3. Choose one evidence transport:
   - direct server MCP: add `FLODESK_MCP_URL` and, when required, the scoped
     read-only `FLODESK_MCP_AUTH_TOKEN` Replit secret; or
   - temporary ChatGPT bridge: add `FLODESK_CHATGPT_MCP_AUTH_TOKEN` and follow
     [`../../../docs/integrations/flodesk-chatgpt-bridge.md`](../../../docs/integrations/flodesk-chatgpt-bridge.md).
4. For the direct transport, run one manual verification from the Replit shell:

   ```bash
   pnpm --filter @workspace/api-server run sync:flodesk
   ```

The command must report the existing unsubscribe counts plus campaign and
recipient-evidence counts. Re-running it is safe. Do not print either secret.

## Rollback

Disable only the direct MCP evidence path with
`DISABLE_FLODESK_ENGAGEMENT_SYNC=1`, or pause the ChatGPT scheduled task to
disable the bridge. The existing subscriber/unsubscribe synchronization
continues independently. The added columns can remain in place; they are inert
and preserve replay watermarks.
