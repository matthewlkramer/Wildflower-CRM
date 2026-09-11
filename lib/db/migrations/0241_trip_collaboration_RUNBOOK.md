# Trip collaboration

Adds a distinct next step and last-editor attribution to each person on a trip,
plus an append-only, attributed comment thread. Existing trip and visit notes
are preserved unchanged.

Apply `0241_trip_collaboration.sql` in one transaction before deploying the
application. Verify that editing a visit records the current user and that a
new trip comment appears with its author and timestamp. Roll back the
application before dropping the new table and columns; export comments first
if their history must be retained.
