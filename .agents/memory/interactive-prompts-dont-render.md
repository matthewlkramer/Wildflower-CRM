---
name: user_query widget does not render for this user
description: The interactive question/prompt UI never displays for this user — always ask in plain-text chat instead.
---

# Interactive prompt widget does not display — ask in plain text

The `user_query` interactive prompt (choice/boolean/text widgets) **never
renders** in this user's client — they see nothing when it is sent, so the
turn stalls with an unanswerable question.

**How to apply:** Do NOT use the `user_query` tool for this user. Ask any
clarifying question directly in the plain-text chat response (numbered options
are fine as text). Same for anything that would surface an interactive widget
where a plain-text ask works.

**Why:** Confirmed directly — user reported "input never works / no questions
display" when a `choice_query` was sent. Firing the widget just wastes a turn.
