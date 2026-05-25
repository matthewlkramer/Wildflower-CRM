# Wildflower CRM — UI Regression Testing Plan

A living checklist of every page, button, and user flow. Use this two ways:

1. **Manual smoke** — walk the "Smoke Path" below before merging anything risky (≈ 5 min).
2. **Automated** — feed any of the `runTest()` blocks at the bottom of this doc to the Playwright testing subagent. Each block is self-contained: it sets up its own data, exercises the flow, asserts the outcome, and cleans up where possible.

The dev DB is shared with the user, so tests must:
- Generate unique names (suffix with a short random id),
- Never assert exact row counts,
- Clean up records they create (or mark them so they're easy to spot).

---

## 1. Routes inventory

| Route | Page file | Auth |
|---|---|---|
| `/` | `home.tsx` | public landing |
| `/sign-in/*` `/sign-up/*` | Clerk | public |
| `/dashboard` | `dashboard.tsx` | yes |
| `/individuals` | `individuals.tsx` | yes |
| `/individuals/:id` | `individual-detail.tsx` | yes |
| `/households` | `households.tsx` | yes |
| `/households/:id` | `household-detail.tsx` | yes |
| `/funding-entities` | `funding-entities.tsx` | yes |
| `/funding-entities/:id` | `funding-entity-detail.tsx` | yes |
| `/pipeline` | `pipeline.tsx` | yes |
| `/opportunities` | `opportunities.tsx` | yes |
| `/opportunities/:id` | `opportunity-detail.tsx` | yes |
| `/pledges` | `pledges.tsx` | yes |
| `/pledges/:id` | `pledge-detail.tsx` | yes |
| `/gifts` | `gifts.tsx` | yes |
| `/gifts/:id` | `gift-detail.tsx` | yes |
| `/moves` | `moves.tsx` | yes |
| `/interactions` | `interactions.tsx` | yes |
| `/projections` | `projections.tsx` | yes |
| `/fiscal-year/:fyId` | `fiscal-year-detail.tsx` | yes |
| `/grants-calendar` | `grants-calendar.tsx` | yes |
| `/admin` | `admin.tsx` | admin only |
| anything else | `not-found.tsx` | — |

---

## 2. Per-page checklist

Each page's checklist covers: **renders without 500/console errors**, **all buttons / links work**, and **expected data shows**. The `runTest()` blocks in §4 cover the most error-prone flows automatically.

### Global (every protected page)
- [ ] Top nav links navigate without full reload
- [ ] Signed-out users get redirected to `/sign-in`
- [ ] No red errors in browser console, no 500s in API logs
- [ ] Page title updates correctly

### `/dashboard`
- [ ] KPI cards render numbers (no `NaN`, no `—` for everything)
- [ ] FY selector switches the data
- [ ] Entity filter chips switch the data
- [ ] Tile links navigate to `/projections`, `/grants-calendar`, `/moves`
- [ ] "Show all FY" / "Show retired" toggles work

### `/individuals`
- [ ] Search box filters list
- [ ] Region / capacity / deceased filters work
- [ ] Pagination prev/next + first/last page disabled correctly
- [ ] "New individual" button opens create dialog → creates row → navigates to detail
- [ ] Row click → `/individuals/:id`
- [ ] Email/phone shortcuts (`mailto:` / `tel:`) don't trigger row nav (stopPropagation)

### `/individuals/:id`  ⚠ regression: ambiguous-id 500 (fixed 2026-05-25)
- [ ] Page loads (no 500)
- [ ] Edit name → save → name updates
- [ ] Cancel edit reverts value
- [ ] Lifetime giving / most-recent-gift / open-opps tiles render
- [ ] Active funder chips link to `/funding-entities/:id`
- [ ] Timeline shows interactions (emails + calendar) when present
- [ ] Per-interaction privacy toggle flips between Visible/Private
- [ ] Delete confirms then redirects to `/individuals`

### `/households`
- [ ] List + search + active filter + pagination
- [ ] New household → create → detail
- [ ] Row click → detail

### `/households/:id`  ⚠ regression: same ambiguous-id family
- [ ] Page loads (no 500)
- [ ] Edit name save / cancel
- [ ] Toggle active button flips status
- [ ] Member rows link to `/individuals/:id`
- [ ] Delete → redirects to `/households`

### `/funding-entities`
- [ ] List, search, type filter, pagination
- [ ] New funder → create → detail
- [ ] Row click → detail; email link uses stopPropagation

### `/funding-entities/:id`  ⚠ regression: same ambiguous-id family
- [ ] Page loads (no 500)
- [ ] Edit name / details save & cancel
- [ ] Primary contact link → `/individuals/:id`
- [ ] Lifetime giving + open opps render
- [ ] Delete → redirects to `/funding-entities`

### `/pipeline`
- [ ] Columns render (one per stage)
- [ ] Drag (or stage dropdown) updates opportunity stage; refetch reflects change
- [ ] Card link → `/opportunities/:id` (stopPropagation prevents drag)
- [ ] "New opportunity" CTA

### `/opportunities` and `/pledges` (same view, status-filtered)
- [ ] List + search + stage filter + pagination
- [ ] New opp / new pledge creates and navigates

### `/opportunities/:id` and `/pledges/:id`
- [ ] Donor link routes correctly for each donor-XOR variant (funder / individual / household)
- [ ] Edit name save / cancel
- [ ] Allocation rows render with FY + entity + amount
- [ ] Payments table links to `/gifts/:id`
- [ ] Status change to **closed** requires completion date — invalid POST returns 400, UI surfaces the error
- [ ] Setting two donors at once is rejected (donor-XOR invariant)
- [ ] Delete → redirects to list

### `/gifts`
- [ ] List + search + FY filter + pagination
- [ ] New gift creates and navigates
- [ ] Row click → detail

### `/gifts/:id`
- [ ] Donor link works for each XOR variant
- [ ] "Payment on pledge" link → `/pledges/:id`
- [ ] "Gift being matched" link → `/gifts/:id`
- [ ] Edit name save / cancel
- [ ] Allocations render
- [ ] Donor-XOR violation on update returns 400 (not 500)
- [ ] Delete → redirects to `/gifts`

### `/moves`
- [ ] List of people with stage changes renders
- [ ] Each row links to the person

### `/interactions`
- [ ] List loads
- [ ] Pagination prev/next
- [ ] Privacy toggle on a row hides it from non-owners (verify via second user if available)
- [ ] Email body + attachments render only for matched emails

### `/projections`
- [ ] FY rows render; entity filter chips work
- [ ] FY row click → `/fiscal-year/:fyId`

### `/fiscal-year/:fyId`
- [ ] FY selector switches view (URL updates)
- [ ] Show-all-FY + show-retired toggles
- [ ] Gift rows link to `/gifts/:id`
- [ ] Opp rows link to `/opportunities/:id`

### `/grants-calendar`
- [ ] Upcoming deadlines list renders
- [ ] Opportunity link → `/opportunities/:id`
- [ ] Funder link uses stopPropagation

### `/admin` (admin role required)
- [ ] Non-admin: section hidden / 403 swallowed
- [ ] Admin: Google connect / disconnect / reconnect buttons appear and work
- [ ] Per-user "Resync now" button triggers a sync and refetches table (30 s auto-refetch)
- [ ] Entity goals: create, update, delete fiscal-year-entity goal
- [ ] Show-all-FY + show-retired toggles
- [ ] "Bootstrap in flight" / "X failed; will retry" badges render

### `not-found.tsx`
- [ ] Random URL like `/this-does-not-exist` shows the 404 page (not a blank screen)

---

## 3. Cross-cutting regressions worth pinning

These are bugs we've actually hit — keep them in the suite forever.

| Date | Symptom | Root cause | Test that catches it |
|---|---|---|---|
| 2026-05-25 | `/individuals/:id` 500 | Drizzle inlining `${people.id}` as bare `"id"` ambiguous against subquery's own `id` | "Detail-page smoke" block in §4 |
| 2026-05-23 | Opp/gift POST 500 instead of 400 | Donor-XOR + closed-requires-completion-date CHECK constraints | "Donor-XOR invariant" block in §4 |
| Stage 3 | Email body leaks to non-matched threads | matcher bypass | "Email privacy" block in §4 |

---

## 4. Automated `runTest()` plan blocks

Feed any of these to the Playwright subagent (`await runTest({ testPlan, relevantTechnicalDocumentation })`). All blocks assume the tester logs in via Clerk per the `clerk-auth` testing addendum before step 2.

### A. Smoke — every page loads (5 min, run after any backend change)

```text
1. [New Context] Create a new browser context, sign in as a normal user.
2. [Browser] Visit each of these paths in turn and assert (a) HTTP 200,
   (b) no red console errors, (c) page is not the 404 component:
   /dashboard, /individuals, /households, /funding-entities, /pipeline,
   /opportunities, /pledges, /gifts, /moves, /interactions, /projections,
   /grants-calendar, /admin
3. [Browser] On /individuals, click the first row. Assert it lands on
   /individuals/<id> and the name header is visible.
4. [Browser] Repeat step 3 for /households, /funding-entities,
   /opportunities, /pledges, /gifts.
5. [Verify] Backend log file has zero "ERROR" lines during steps 2–4.
```

### B. Detail-page smoke (catches the ambiguous-id 500 family)

```text
1. [New Context] Sign in.
2. [API] GET /api/people?limit=1 → note id as ${pid}.
        GET /api/households?limit=1 → ${hid}.
        GET /api/funders?limit=1 → ${fid}.
3. [Browser] Visit /individuals/${pid}; assert 200 and the lifetime-giving
   tile is present (this is the field whose subquery had the bug).
4. [Browser] Visit /households/${hid}; assert 200 and lifetime-giving tile.
5. [Browser] Visit /funding-entities/${fid}; assert 200 and lifetime-giving
   tile.
6. [Verify] No "column reference \"id\" is ambiguous" anywhere in API logs.
```

### C. Create → edit → delete a person

```text
1. [New Context] Sign in.
2. [Browser] /individuals → click "New individual"
3. [Browser] Fill firstName=Test, lastName=User-${nanoid(6)}; submit.
4. [Verify] Redirect to /individuals/<newId>; name header matches.
5. [Browser] Click edit, change lastName to "User-${nanoid(6)}-edited", save.
6. [Verify] New name renders.
7. [Browser] Click delete, confirm.
8. [Verify] Redirect to /individuals; new name not in the list.
```

### D. Donor-XOR invariant (opp + gift)

```text
1. [New Context] Sign in.
2. [API] POST /api/opportunities-and-pledges with BOTH funderId and
   individualGiverPersonId set.
3. [Verify] Response is 400 (not 500), error mentions donor invariant.
4. [API] POST /api/opportunities-and-pledges with status=closed and no
   completionDate.
5. [Verify] Response is 400 (not 500).
6. Repeat steps 2 and 4 against /api/gifts-and-payments.
```

### E. Pipeline drag → stage update

```text
1. [New Context] Sign in.
2. [API] Create a test opportunity in stage "qualified".
3. [Browser] /pipeline → drag the test card into the "proposal" column.
4. [Verify] PATCH /api/opportunities-and-pledges/<id> fires with stage=proposal,
   200 response.
5. [Browser] Reload /pipeline; card is in proposal column.
6. [API] Delete the test opportunity.
```

### F. Email privacy on detail timeline

```text
1. [New Context] Sign in as user A.
2. [API] Find an interaction owned by A. PATCH it to private=true.
3. [Verify] /individuals/<personId> timeline (as A) still shows it with
   a "private" badge.
4. [New Context] Sign in as user B (different normal user).
5. [Verify] Same /individuals/<personId> timeline does NOT show that
   interaction (or shows a redacted stub with no body/attachments).
6. [API] PATCH the interaction back to private=false (cleanup).
```

### G. Admin sync panel (admin only)

```text
1. [New Context] Sign in as admin user.
2. [Browser] /admin → assert "Google sync" section is visible.
3. [Browser] Click "Resync now" on a connected user row.
4. [Verify] POST /api/admin/google-sync/<userId>/resync returns 200; row
   "last run" timestamp updates within 30 s (auto-refetch).
5. [New Context] Sign in as non-admin.
6. [Verify] /admin loads but the Google sync section is hidden (403
   swallowed silently).
```

### H. 404

```text
1. [New Context] Sign in.
2. [Browser] /definitely-not-a-real-route-${nanoid(6)}
3. [Verify] The not-found component renders (text "Not Found" or similar),
   not a blank screen or 500.
```

---

## 5. How to use this doc going forward

- **Before a risky change**: run §4-A (smoke) + the §4 block matching the area you touched.
- **After landing a feature**: add a new §4 block for that feature; add a row to §3 if a real bug shipped and you want a permanent guard.
- **Before deploying**: §4-A + §4-B + §4-D + §4-G at minimum.

The Playwright runner picks up data-testid hooks first when present
(`google-connect`, `google-reconnect`, `new-entity-submit`,
`button-edit-gift-name`, `button-edit-opp-name`, etc.). When adding
buttons, please keep tagging them so this plan stays low-maintenance.
