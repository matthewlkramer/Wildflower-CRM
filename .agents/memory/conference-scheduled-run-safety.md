---
name: Scheduled conference research safety
description: Ownership and failure boundaries for overlapping one-shot conference research runs.
---

The process that actually works on conference research must own its database advisory lock for the full run. A separate supervising process can enforce a hard deadline, but it must not be the sole lock owner.

**Why:** A supervisor can die or lose its database session while its child keeps processing. If the lock disappears, another scheduled invocation can reclaim a live but older lease after the stale-lease interval and discard the original worker's result.

**How to apply:** Keep the lock in the worker process, fail on lock-session loss, and give the worker its own hard deadline before the platform's job timeout. Preserve row leases and unique window keys as the separate protection for individual requests. A killed worker leaves its durable request for later stale-lease recovery.