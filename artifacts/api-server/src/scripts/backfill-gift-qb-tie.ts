/**
 * RETIRED (Task #451): quickbooks_tie_status is no longer a stored column —
 * it is derived LIVE at query time by deriveGiftQbTieLiveExpr(). There is
 * nothing to backfill. This script is a no-op kept for historical reference.
 */
async function main(): Promise<void> {
  console.log(
    "backfill:gift-qb-tie is retired — quickbooks_tie_status was DROPPED (Task #451).",
  );
  console.log(
    "The QB-tie status is now derived LIVE at query time. No backfill needed.",
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Script failed:", err);
    process.exit(1);
  });
