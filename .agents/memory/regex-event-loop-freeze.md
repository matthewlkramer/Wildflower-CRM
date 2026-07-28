---
name: Regex backtracking can freeze the whole API server
description: Email-intel detectors run inline on the sync scheduler event loop; one catastrophic-backtracking regex on one poisoned email froze dev AND prod. Hardening rules + live-process debugging technique.
---

# Regex backtracking froze the server (July 2026)

**Rule:** Any regex that runs over external text (email bodies, synced
documents) on the main event loop must be linear-time by construction:

- Never put `\s` (or any separator) inside an alternation under an unbounded
  quantifier — e.g. `(?:Word|\s|of|the)+?` is the exponential class that froze
  the server.
- Normalize whitespace first (collapse runs), then match single-char
  separators like `[ \n]` instead of `\s+`.
- Use bounded, deterministic token sequences (`(?:sep token){0,9}?`) instead
  of ambiguous alternations.
- Cap scan length (`MAX_SCAN_CHARS`) before matching.

**Why:** The sync pipeline processes messages inline on the event loop. One
almost-matching email ("… is now predicting that half of all global
organizations …" — long prose after a pattern prefix, no terminator) pegged
the CPU indefinitely. Because the input is data-driven and the sync cursor
never advances past the poisoned message, the same email froze dev and put
prod into a healthcheck-fail terminate/restart loop until a fixed build was
published. False negatives are cheap in this pipeline; unbounded matching is
catastrophic.

**How to debug a frozen Node process (keeps the evidence alive):**
1. `kill -USR1 <pid>` opens the inspector on 127.0.0.1:9229 without killing it.
2. Fetch `http://127.0.0.1:9229/json`, open the WebSocket, `Debugger.enable`
   then `Debugger.pause` → the paused stack names the exact stuck function.
3. `Debugger.evaluateOnCallFrame` on the top frame extracts the live local
   variables — including the actual poison input — for a definitive repro.
   Synthetic repro guesses failed twice; the live-extracted input reproduced
   the hang immediately.

**How to apply:** When adding or editing any detector/parser that runs during
sync, check its regexes against the rules above and add a speed regression
test (adversarial almost-matching input, assert < 2s). Anchor:
`intel-detectors.test.ts` "terminates quickly on long almost-matching prose".
