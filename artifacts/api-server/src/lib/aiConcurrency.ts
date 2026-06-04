import pLimit from "p-limit";

/**
 * Process-global concurrency gate for AI proposal calls to the shared
 * Anthropic integration proxy.
 *
 * Both the inline fire-and-forget fan-out (one call per newly-inserted
 * proposal during a sync) and the sequential pending sweeps route their
 * `anthropic.messages.create` through `proposeActionsForProposal`, which
 * runs the call inside this single limiter. That bounds how many requests
 * we burst at the rate-limited shared proxy at once: a sync that ingests
 * dozens of emails can no longer fire dozens of simultaneous AI calls.
 *
 * The sweeps are already strictly sequential, so they only ever hold one
 * slot at a time; the cap exists to throttle the inline burst. Tunable via
 * AI_PROPOSAL_CONCURRENCY (default 2, matching the batch helper's default).
 */
const MAX = Math.max(1, Number(process.env.AI_PROPOSAL_CONCURRENCY) || 2);

export const aiProposalLimit = pLimit(MAX);
