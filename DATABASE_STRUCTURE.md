# Wildflower CRM — Database Structure

_Snapshot generated from live PostgreSQL schema. Row counts reflect current seed data._

## Table Overview

| # | Table | Rows | Columns |
|---|-------|------|---------|
| 1 | affiliations | 4 | 12 |
| 2 | campaigns | 2 | 11 |
| 3 | contact_addresses | 7 | 16 |
| 4 | contact_emails | 8 | 11 |
| 5 | contact_phones | 2 | 10 |
| 6 | cultivation_team_members | 0 | 8 |
| 7 | funding_entities | 3 | 18 |
| 8 | gift_allocations | 4 | 8 |
| 9 | gift_soft_credits | 1 | 7 |
| 10 | gifts | 4 | 17 |
| 11 | household_members | 3 | 9 |
| 12 | households | 2 | 9 |
| 13 | individual_relationships | 1 | 9 |
| 14 | individuals | 5 | 26 |
| 15 | move_participants | 0 | 4 |
| 16 | moves | 4 | 18 |
| 17 | opportunities | 6 | 30 |
| 18 | organizations | 2 | 9 |
| 19 | pledge_installments | 3 | 10 |
| 20 | pledges | 1 | 16 |
| 21 | tag_links | 3 | 6 |
| 22 | tags | 3 | 7 |
| 23 | users | 3 | 10 |

**Total: 23 tables, 248 columns, 69 seeded rows.**

---

## Tables

### 1. `affiliations` (4 rows)
Links individuals to funding entities or organizations (employment, board seats, etc.).

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | individual_id | text | NOT NULL | → individuals(id) CASCADE |
| 3 | funding_entity_id | text | nullable | → funding_entities(id) CASCADE |
| 4 | organization_id | text | nullable | → organizations(id) CASCADE |
| 5 | role | text | nullable | |
| 6 | affiliation_type | enum `affiliation_type` | NOT NULL | |
| 7 | start_date | date | nullable | |
| 8 | end_date | date | nullable | |
| 9 | is_current | boolean | NOT NULL | true |
| 10 | notes | text | nullable | |
| 11 | created_at | timestamp | NOT NULL | now() |
| 12 | updated_at | timestamp | NOT NULL | now() |

### 2. `campaigns` (2 rows)
Fundraising campaigns scoped by fund and fiscal year.

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | name | text | NOT NULL | |
| 3 | fund | enum `fund` | nullable | |
| 4 | fiscal_year | enum `fiscal_year` | nullable | |
| 5 | start_date | date | nullable | |
| 6 | end_date | date | nullable | |
| 7 | goal_amount | numeric(15,2) | nullable | |
| 8 | description | text | nullable | |
| 9 | is_active | boolean | NOT NULL | true |
| 10 | created_at | timestamp | NOT NULL | now() |
| 11 | updated_at | timestamp | NOT NULL | now() |

### 3. `contact_addresses` (7 rows)
Polymorphic mailing addresses (individuals, households, funding entities, organizations).

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | owner_type | enum `contact_owner_type` | NOT NULL | |
| 3 | owner_id | text | NOT NULL | |
| 4 | line1 | text | NOT NULL | |
| 5 | line2 | text | nullable | |
| 6 | city | text | nullable | |
| 7 | state | text | nullable | |
| 8 | postal_code | text | nullable | |
| 9 | country | text | nullable | 'US' |
| 10 | metro_area | text | nullable | |
| 11 | label | enum `address_label` | nullable | 'home' |
| 12 | is_primary | boolean | NOT NULL | false |
| 13 | mail_opted_out | boolean | NOT NULL | false |
| 14 | notes | text | nullable | |
| 15 | created_at | timestamp | NOT NULL | now() |
| 16 | updated_at | timestamp | NOT NULL | now() |

### 4. `contact_emails` (8 rows)
Polymorphic email addresses with bounce/opt-out tracking.

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | owner_type | enum `contact_owner_type` | NOT NULL | |
| 3 | owner_id | text | NOT NULL | |
| 4 | email | text | NOT NULL | |
| 5 | label | enum `email_label` | nullable | 'personal' |
| 6 | is_primary | boolean | NOT NULL | false |
| 7 | is_bounced | boolean | NOT NULL | false |
| 8 | opted_out | boolean | NOT NULL | false |
| 9 | notes | text | nullable | |
| 10 | created_at | timestamp | NOT NULL | now() |
| 11 | updated_at | timestamp | NOT NULL | now() |

### 5. `contact_phones` (2 rows)
Polymorphic phone numbers with SMS opt-out.

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | owner_type | enum `contact_owner_type` | NOT NULL | |
| 3 | owner_id | text | NOT NULL | |
| 4 | phone | text | NOT NULL | |
| 5 | label | enum `phone_label` | nullable | 'mobile' |
| 6 | is_primary | boolean | NOT NULL | false |
| 7 | sms_opted_out | boolean | NOT NULL | false |
| 8 | notes | text | nullable | |
| 9 | created_at | timestamp | NOT NULL | now() |
| 10 | updated_at | timestamp | NOT NULL | now() |

### 6. `cultivation_team_members` (0 rows)
Polymorphic membership of staff users on a donor's cultivation team. Unique on (owner_type, owner_id, user_id, role).

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | owner_type | enum `cultivation_team_owner_type` | NOT NULL | |
| 3 | owner_id | text | NOT NULL | |
| 4 | user_id | text | NOT NULL | → users(id) CASCADE |
| 5 | role | enum `cultivation_team_role` | NOT NULL | |
| 6 | notes | text | nullable | |
| 7 | created_at | timestamp | NOT NULL | now() |
| 8 | updated_at | timestamp | NOT NULL | now() |

### 7. `funding_entities` (3 rows)
Foundations, DAF accounts, government agencies, corporates.

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | legal_name | text | NOT NULL | |
| 3 | display_name | text | nullable | |
| 4 | subtype | enum `funding_entity_subtype` | NOT NULL | |
| 5 | ein | text | nullable | |
| 6 | website | text | nullable | |
| 7 | primary_contact_id | text | nullable | → individuals(id) SET NULL |
| 8 | relationship_owner_user_id | text | nullable | → users(id) SET NULL |
| 9 | institutional_cultivation_stage | enum `institutional_cultivation_stage` | nullable | |
| 10 | government_cultivation_stage | enum `government_cultivation_stage` | nullable | |
| 11 | enthusiasm | text | nullable | |
| 12 | typical_grant_size_min | numeric(15,2) | nullable | |
| 13 | typical_grant_size_max | numeric(15,2) | nullable | |
| 14 | total_giving | numeric(15,2) | nullable | 0 |
| 15 | last_gift_date | timestamp | nullable | |
| 16 | notes | text | nullable | |
| 17 | created_at | timestamp | NOT NULL | now() |
| 18 | updated_at | timestamp | NOT NULL | now() |

### 8. `gift_allocations` (4 rows)
Splits a gift across one or more funds. `sum(allocations.amount) == gifts.amount` is enforced in the API.

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | gift_id | text | NOT NULL | → gifts(id) CASCADE |
| 3 | fund | enum `fund` | NOT NULL | |
| 4 | amount | numeric(15,2) | NOT NULL | |
| 5 | fiscal_year | enum `fiscal_year` | nullable | |
| 6 | notes | text | nullable | |
| 7 | created_at | timestamp | NOT NULL | now() |
| 8 | updated_at | timestamp | NOT NULL | now() |

### 9. `gift_soft_credits` (1 row)
**⚠️ Currently unused — table exists and is seeded but no API endpoints read or write it.** Candidate for removal.

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | gift_id | text | NOT NULL | → gifts(id) CASCADE |
| 3 | individual_id | text | NOT NULL | → individuals(id) CASCADE |
| 4 | credit_type | enum `gift_soft_credit_type` | NOT NULL | |
| 5 | percentage | numeric(5,2) | nullable | |
| 6 | notes | text | nullable | |
| 7 | created_at | timestamp | NOT NULL | now() |

### 10. `gifts` (4 rows)
Cash-received gift records. **CHECK:** exactly one of `individual_id`, `household_id`, `funding_entity_id` must be set.

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | individual_id | text | nullable | → individuals(id) SET NULL |
| 3 | household_id | text | nullable | → households(id) SET NULL |
| 4 | funding_entity_id | text | nullable | → funding_entities(id) SET NULL |
| 5 | pledge_id | text | nullable | → pledges(id) SET NULL |
| 6 | campaign_id | text | nullable | → campaigns(id) SET NULL |
| 7 | amount | numeric(15,2) | NOT NULL | |
| 8 | currency | text | NOT NULL | 'USD' |
| 9 | cash_received_date | timestamp | NOT NULL | |
| 10 | payment_method | enum `payment_method` | nullable | |
| 11 | check_number | text | nullable | |
| 12 | reconciled | boolean | nullable | false |
| 13 | direct_to_school_passthrough | boolean | nullable | false |
| 14 | fiscal_sponsor_funding_entity_id | text | nullable | → funding_entities(id) SET NULL |
| 15 | fiscal_sponsor_organization_id | text | nullable | → organizations(id) SET NULL |
| 16 | notes | text | nullable | |
| 17 | created_at + updated_at | timestamp | NOT NULL | now() |

### 11. `household_members` (3 rows)
Individuals belonging to a household with role and tenure.

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | household_id | text | NOT NULL | → households(id) CASCADE |
| 3 | individual_id | text | NOT NULL | → individuals(id) CASCADE |
| 4 | role | enum `household_member_role` | NOT NULL | 'other' |
| 5 | start_date | date | nullable | |
| 6 | end_date | date | nullable | |
| 7 | is_current | boolean | NOT NULL | true |
| 8 | created_at | timestamp | NOT NULL | now() |
| 9 | updated_at | timestamp | NOT NULL | now() |

### 12. `households` (2 rows)
Family / couple giving units.

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | name | text | NOT NULL | |
| 3 | primary_owner_user_id | text | nullable | → users(id) SET NULL |
| 4 | status | enum `household_status` | NOT NULL | 'active' |
| 5 | formation_date | timestamp | nullable | |
| 6 | dissolved_date | timestamp | nullable | |
| 7 | notes | text | nullable | |
| 8 | created_at | timestamp | NOT NULL | now() |
| 9 | updated_at | timestamp | NOT NULL | now() |

### 13. `individual_relationships` (1 row)
Directional relationships between individuals (spouse, parent, advisor, etc.).

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | from_individual_id | text | NOT NULL | → individuals(id) CASCADE |
| 3 | to_individual_id | text | NOT NULL | → individuals(id) CASCADE |
| 4 | relationship_type | enum `individual_relationship_type` | NOT NULL | |
| 5 | start_date | date | nullable | |
| 6 | end_date | date | nullable | |
| 7 | is_current | boolean | NOT NULL | true |
| 8 | notes | text | nullable | |
| 9 | created_at + updated_at | timestamp | NOT NULL | now() |

### 14. `individuals` (5 rows)
Person records (donors, prospects, contacts at funding entities).

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | first_name | text | NOT NULL | |
| 3 | last_name | text | NOT NULL | |
| 4 | preferred_name | text | nullable | |
| 5 | pronouns | text | nullable | |
| 6 | linkedin_url | text | nullable | |
| 7 | relationship_owner_user_id | text | nullable | → users(id) SET NULL |
| 8 | strategy_user_id | text | nullable | → users(id) SET NULL |
| 9 | donor_cultivation_stage | enum `donor_cultivation_stage` | nullable | 'pre_qualified' |
| 10 | institutional_contact_stage | enum `institutional_contact_stage` | nullable | |
| 11 | enthusiasm | enum `enthusiasm` | nullable | 'neutral' |
| 12 | capacity_rating | enum `capacity_rating` | nullable | |
| 13 | last_move_date | timestamp | nullable | |
| 14 | last_gift_date | timestamp | nullable | |
| 15 | last_gift_amount | numeric(15,2) | nullable | |
| 16 | total_giving | numeric(15,2) | nullable | 0 |
| 17 | deceased_date | date | nullable | |
| 18 | email_opt_out | boolean | NOT NULL | false |
| 19 | call_opt_out | boolean | NOT NULL | false |
| 20 | mail_opt_out | boolean | NOT NULL | false |
| 21 | text_opt_out | boolean | NOT NULL | false |
| 22 | notes | text | nullable | |
| 23 | created_at | timestamp | NOT NULL | now() |
| 24 | updated_at | timestamp | NOT NULL | now() |

### 15. `move_participants` (0 rows)
Additional staff users present at a move (beyond the primary `staff_user_id`).

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | move_id | text | NOT NULL | → moves(id) CASCADE |
| 3 | user_id | text | NOT NULL | → users(id) CASCADE |
| 4 | created_at | timestamp | NOT NULL | now() |

### 16. `moves` (4 rows)
Cultivation activities (emails, calls, meetings, etc.). **CHECKs:** exactly one subject FK populated; `move_level` matches the populated subject.

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | subject | text | NOT NULL | |
| 3 | move_type | enum `move_type` | NOT NULL | |
| 4 | move_level | enum `move_level` | NOT NULL | |
| 5 | date | timestamp | NOT NULL | |
| 6 | individual_id | text | nullable | → individuals(id) SET NULL |
| 7 | household_id | text | nullable | → households(id) SET NULL |
| 8 | funding_entity_id | text | nullable | → funding_entities(id) SET NULL |
| 9 | opportunity_id | text | nullable | → opportunities(id) SET NULL |
| 10 | staff_user_id | text | nullable | → users(id) SET NULL |
| 11 | summary | text | nullable | |
| 12 | outcome | text | nullable | |
| 13 | next_step | text | nullable | |
| 14 | next_step_due_date | timestamp | nullable | |
| 15 | is_draft | boolean | nullable | false |
| 16 | source | enum `move_source` | nullable | 'manual' |
| 17 | created_at | timestamp | NOT NULL | now() |
| 18 | updated_at | timestamp | NOT NULL | now() |

### 17. `opportunities` (6 rows)
Active asks / grant proposals. **CHECKs:** exactly one donor FK populated; `donor_type` matches the populated FK.

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | name | text | NOT NULL | |
| 3 | subtype | enum `opportunity_subtype` | NOT NULL | |
| 4 | donor_type | enum `opportunity_donor_type` | NOT NULL | |
| 5 | individual_id | text | nullable | → individuals(id) SET NULL |
| 6 | household_id | text | nullable | → households(id) SET NULL |
| 7 | funding_entity_id | text | nullable | → funding_entities(id) SET NULL |
| 8 | owner_user_id | text | nullable | → users(id) SET NULL |
| 9 | fund | enum `fund` | NOT NULL | |
| 10 | region | text | nullable | |
| 11 | amount_expected | numeric(15,2) | nullable | |
| 12 | probability | integer | nullable | 50 |
| 13 | probability_overridden | boolean | nullable | false |
| 14 | stage | enum `opportunity_stage` | NOT NULL | 'pre_conversation' |
| 15 | government_stage | enum `government_opportunity_stage` | nullable | |
| 16 | expected_close_date | timestamp | nullable | |
| 17 | fiscal_year | enum `fiscal_year` | nullable | |
| 18 | roll_forward_count | integer | nullable | 0 |
| 19 | loi_deadline | timestamp | nullable | |
| 20 | loi_submitted | boolean | nullable | false |
| 21 | proposal_deadline | timestamp | nullable | |
| 22 | proposal_submitted | boolean | nullable | false |
| 23 | decision_expected_date | timestamp | nullable | |
| 24 | ask_amount | numeric(15,2) | nullable | |
| 25 | ask_rationale | text | nullable | |
| 26 | pledge_id | text | nullable | |
| 27 | fiscal_sponsor_funding_entity_id | text | nullable | → funding_entities(id) SET NULL |
| 28 | fiscal_sponsor_organization_id | text | nullable | → organizations(id) SET NULL |
| 29 | campaign_id | text | nullable | → campaigns(id) SET NULL |
| 30 | notes + created_at + updated_at | text / timestamp | mixed | |

### 18. `organizations` (2 rows)
Non-funding organizations (employers, fiscal sponsors, partners).

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | name | text | NOT NULL | |
| 3 | legal_name | text | nullable | |
| 4 | website | text | nullable | |
| 5 | industry | text | nullable | |
| 6 | is_philanthropic | boolean | nullable | false |
| 7 | notes | text | nullable | |
| 8 | created_at | timestamp | NOT NULL | now() |
| 9 | updated_at | timestamp | NOT NULL | now() |

### 19. `pledge_installments` (3 rows)
Scheduled installments for a multi-year pledge.

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | pledge_id | text | NOT NULL | → pledges(id) CASCADE |
| 3 | installment_number | integer | NOT NULL | |
| 4 | due_date | timestamp | NOT NULL | |
| 5 | amount | numeric(15,2) | NOT NULL | |
| 6 | status | enum `installment_status` | NOT NULL | 'scheduled' |
| 7 | paid_date | timestamp | nullable | |
| 8 | notes | text | nullable | |
| 9 | created_at | timestamp | NOT NULL | now() |
| 10 | updated_at | timestamp | NOT NULL | now() |

### 20. `pledges` (1 row)
Multi-year pledged commitments. **CHECK:** exactly one of `individual_id`, `household_id`, `funding_entity_id` must be set.

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | name | text | NOT NULL | |
| 3 | fund | enum `fund` | NOT NULL | |
| 4 | individual_id | text | nullable | → individuals(id) SET NULL |
| 5 | household_id | text | nullable | → households(id) SET NULL |
| 6 | funding_entity_id | text | nullable | → funding_entities(id) SET NULL |
| 7 | total_committed_amount | numeric(15,2) | NOT NULL | |
| 8 | currency | text | NOT NULL | 'USD' |
| 9 | pledge_date | timestamp | NOT NULL | |
| 10 | number_of_installments | integer | NOT NULL | 1 |
| 11 | status | enum `pledge_status` | NOT NULL | 'active' |
| 12 | amount_received | numeric(15,2) | nullable | 0 |
| 13 | legal_document_on_file | boolean | nullable | false |
| 14 | notes | text | nullable | |
| 15 | created_at | timestamp | NOT NULL | now() |
| 16 | updated_at | timestamp | NOT NULL | now() |

### 21. `tag_links` (3 rows)
Polymorphic tag → entity attachments.

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | tag_id | text | NOT NULL | → tags(id) CASCADE |
| 3 | entity_type | enum `tag_entity_type` | NOT NULL | |
| 4 | entity_id | text | NOT NULL | |
| 5 | created_by_user_id | text | nullable | → users(id) SET NULL |
| 6 | created_at | timestamp | NOT NULL | now() |

### 22. `tags` (3 rows)
Reusable labels.

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | name | text | NOT NULL | |
| 3 | category | text | nullable | |
| 4 | color | text | nullable | |
| 5 | is_system | boolean | NOT NULL | false |
| 6 | created_at | timestamp | NOT NULL | now() |
| 7 | _ | _ | _ | _ |

### 23. `users` (3 rows)
Wildflower staff (synced from Clerk).

| # | Column | Type | Null | Default |
|---|--------|------|------|---------|
| 1 | id | text | NOT NULL | |
| 2 | clerk_id | text | NOT NULL | |
| 3 | email | text | NOT NULL | |
| 4 | first_name | text | nullable | |
| 5 | last_name | text | nullable | |
| 6 | display_name | text | nullable | |
| 7 | role | enum `user_role` | NOT NULL | 'team_member' |
| 8 | default_fund | enum `fund` | nullable | |
| 9 | created_at | timestamp | NOT NULL | now() |
| 10 | updated_at | timestamp | NOT NULL | now() |

---

## Enums

| # | Enum | Values |
|---|------|--------|
| 1 | `address_label` | home, work, seasonal, mailing, other |
| 2 | `affiliation_type` | employee, board_member, trustee, advisor, founder, volunteer, other |
| 3 | `capacity_rating` | tier_1k_10k, tier_10k_50k, tier_50k_250k, tier_250k_1m, tier_1m_plus |
| 4 | `contact_owner_type` | individual, household, funding_entity, organization |
| 5 | `cultivation_team_owner_type` | individual, household, funding_entity |
| 6 | `cultivation_team_role` | relationship_owner, strategy, support, primary_solicitor |
| 7 | `donor_cultivation_stage` | pre_qualified, qualified, have_path_to_connect, connected, in_relationship, lapsed_relationship |
| 8 | `email_label` | personal, work, school, other |
| 9 | `enthusiasm` | active_opposition, unsupportive, skeptical, neutral, warm, supportive, advocate |
| 10 | `fiscal_year` | FY23, FY24, FY25, FY26, FY27, FY28, FY29, FY30 |
| 11 | `fund` | general_operating, seed_fund, black_wildflowers, sunlight |
| 12 | `funding_entity_subtype` | institutional_foundation, family_foundation, daf_account, government_agency, corporate |
| 13 | `gift_soft_credit_type` | spouse, advisor, introducer, event_captain, household_member, other |
| 14 | `government_cultivation_stage` | rfp_watching, rfp_active, submitted, awarded, active_grant, closed, not_applicable |
| 15 | `government_opportunity_stage` | rfp_watching, application_in_progress, submitted, under_review, awarded, not_awarded |
| 16 | `household_member_role` | primary, spouse_partner, dependent, other |
| 17 | `household_status` | active, dissolved |
| 18 | `individual_relationship_type` | spouse, ex_spouse, partner, parent, child, sibling, in_law, donor_advisor, assistant_to, referred_by, other |
| 19 | `installment_status` | scheduled, paid, overdue, waived |
| 20 | `institutional_contact_stage` | uncontacted, initial_outreach, connected, relationship_active, lapsed |
| 21 | `institutional_cultivation_stage` | prospect, research, letter_of_inquiry, proposal, decision_pending, funded, stewardship, declined, inactive |
| 22 | `move_level` | individual, household, funding_entity |
| 23 | `move_source` | manual, gmail, calendar |
| 24 | `move_type` | email, call, meeting, site_visit, event, letter, proposal_submission, report, other |
| 25 | `opportunity_donor_type` | individual, household, family_foundation, institutional_foundation, daf_account, government_rfp |
| 26 | `opportunity_stage` | pre_conversation, conversation, solicitation, negotiation, committed, funded, stewarding, declined, withdrawn |
| 27 | `opportunity_subtype` | ongoing_rolling, targeted_deadline, rfp_proposal |
| 28 | `payment_method` | check, wire, ach, credit_card, stock, daf_grant, in_kind, other |
| 29 | `phone_label` | mobile, home, work, other |
| 30 | `pledge_status` | active, completed, revised, defaulted |
| 31 | `tag_entity_type` | individual, household, funding_entity, organization, opportunity, gift, move |
| 32 | `user_role` | admin, team_member, finance, read_only |

**Total: 32 enums.**
