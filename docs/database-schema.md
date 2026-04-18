# Wildflower CRM — Database Schema Reference

> Generated from `lib/db/src/schema/*.ts`. All field names shown in camelCase (as used in code); the database column is the snake_case equivalent.

---

## Shared Enums

These enums are used across multiple tables.

### `fund`
The four fundraising funds.

| Value | Label |
|---|---|
| `general_operating` | General Operating |
| `seed_fund` | Seed Fund |
| `black_wildflowers` | Black Wildflowers |
| `sunlight` | Sunlight |

---

## Tables

1. [users](#users)
2. [individuals](#individuals)
3. [households](#households)
4. [funding\_entities](#funding_entities)
5. [funding\_entity\_people](#funding_entity_people)
6. [opportunities](#opportunities)
7. [pledges](#pledges)
8. [pledge\_installments](#pledge_installments)
9. [gifts](#gifts)
10. [moves](#moves)
11. [move\_participants](#move_participants)

---

## `users`

Staff accounts, auto-provisioned on first Clerk sign-in.

| Field | Type | Req | Default | Notes / Options |
|---|---|---|---|---|
| id | text | ✓ | — | Primary key |
| clerkId | text | ✓ | — | Unique; from Clerk auth |
| email | text | ✓ | — | Unique |
| firstName | text | | — | |
| lastName | text | | — | |
| displayName | text | | — | |
| role | enum | ✓ | `team_member` | `admin`, `team_member`, `finance`, `read_only` |
| defaultFund | enum | | — | See [fund](#fund) |
| createdAt | timestamp | ✓ | now() | |
| updatedAt | timestamp | ✓ | now() | |

---

## `individuals`

Individual donor and prospect records.

| Field | Type | Req | Default | Notes / Options |
|---|---|---|---|---|
| id | text | ✓ | — | Primary key |
| firstName | text | ✓ | — | |
| lastName | text | ✓ | — | |
| preferredName | text | | — | |
| pronouns | text | | — | |
| primaryEmail | text | | — | |
| primaryPhone | text | | — | |
| secondaryEmail | text | | — | |
| linkedinUrl | text | | — | |
| metroArea | text | | — | |
| householdId | text | | — | FK → households |
| relationshipOwnerUserId | text | | — | FK → users |
| strategyUserId | text | | — | FK → users |
| donorCultivationStage | enum | | `pre_qualified` | `pre_qualified`, `qualified`, `have_path_to_connect`, `connected`, `in_relationship`, `lapsed_relationship` |
| institutionalContactStage | enum | | — | `uncontacted`, `initial_outreach`, `connected`, `relationship_active`, `lapsed` |
| enthusiasm | enum | | `neutral` | `active_opposition`, `unsupportive`, `skeptical`, `neutral`, `warm`, `supportive`, `advocate` |
| capacityRating | enum | | — | `tier_1k_10k`, `tier_10k_50k`, `tier_50k_250k`, `tier_250k_1m`, `tier_1m_plus` |
| lastMoveDate | timestamp | | — | Updated automatically when a move is logged |
| lastGiftDate | timestamp | | — | |
| lastGiftAmount | numeric(15,2) | | — | |
| totalGiving | numeric(15,2) | | `0` | Running total of all gifts |
| doNotContact | boolean | | `false` | |
| isDeceased | boolean | | `false` | |
| notes | text | | — | |
| createdAt | timestamp | ✓ | now() | |
| updatedAt | timestamp | ✓ | now() | |

---

## `households`

A grouping of individuals who give together (e.g. couples, families).

| Field | Type | Req | Default | Notes / Options |
|---|---|---|---|---|
| id | text | ✓ | — | Primary key |
| name | text | ✓ | — | e.g. "The Smith Family" |
| primaryOwnerUserId | text | | — | FK → users |
| notes | text | | — | |
| createdAt | timestamp | ✓ | now() | |
| updatedAt | timestamp | ✓ | now() | |

---

## `funding_entities`

Institutional funders: foundations, DAFs, government agencies, corporates.

| Field | Type | Req | Default | Notes / Options |
|---|---|---|---|---|
| id | text | ✓ | — | Primary key |
| legalName | text | ✓ | — | Full legal name |
| displayName | text | | — | Shorter working name |
| subtype | enum | ✓ | — | `institutional_foundation`, `family_foundation`, `daf_account`, `government_agency`, `corporate` |
| ein | text | | — | Employer Identification Number |
| website | text | | — | |
| primaryContactId | text | | — | FK → individuals |
| relationshipOwnerUserId | text | | — | FK → users |
| institutionalCultivationStage | enum | | — | `prospect`, `research`, `letter_of_inquiry`, `proposal`, `decision_pending`, `funded`, `stewardship`, `declined`, `inactive` |
| governmentCultivationStage | enum | | — | `rfp_watching`, `rfp_active`, `submitted`, `awarded`, `active_grant`, `closed`, `not_applicable` |
| enthusiasm | text | | — | Free text (not an enum) |
| typicalGrantSizeMin | numeric(15,2) | | — | |
| typicalGrantSizeMax | numeric(15,2) | | — | |
| totalGiving | numeric(15,2) | | `0` | Running total |
| lastGiftDate | timestamp | | — | |
| notes | text | | — | |
| createdAt | timestamp | ✓ | now() | |
| updatedAt | timestamp | ✓ | now() | |

---

## `funding_entity_people`

Junction table linking individuals to funding entities (e.g. program officers, EDs).

| Field | Type | Req | Default | Notes / Options |
|---|---|---|---|---|
| id | text | ✓ | — | Primary key |
| fundingEntityId | text | ✓ | — | FK → funding_entities (cascade delete) |
| individualId | text | ✓ | — | FK → individuals (cascade delete) |
| role | text | | — | Free text, e.g. "Program Officer", "Executive Director" |
| createdAt | timestamp | ✓ | now() | |

---

## `opportunities`

A single fundraising ask — connects a donor to a fund with a pipeline stage.

| Field | Type | Req | Default | Notes / Options |
|---|---|---|---|---|
| id | text | ✓ | — | Primary key |
| name | text | ✓ | — | |
| subtype | enum | ✓ | — | `ongoing_rolling`, `targeted_deadline`, `rfp_proposal` |
| donorType | enum | ✓ | — | `individual`, `household`, `family_foundation`, `institutional_foundation`, `daf_account`, `government_rfp` |
| individualId | text | | — | FK → individuals (set null on delete) |
| householdId | text | | — | FK → households (set null on delete) |
| fundingEntityId | text | | — | FK → funding_entities (set null on delete) |
| ownerUserId | text | | — | FK → users (set null on delete) |
| fund | enum | ✓ | — | See [fund](#fund) |
| region | text | | — | |
| amountExpected | numeric(15,2) | | — | |
| probability | integer | | `50` | 0–100; used in weighted pipeline calc |
| probabilityOverridden | boolean | | `false` | If true, uses `probability` instead of stage default |
| stage | enum | ✓ | `pre_conversation` | `pre_conversation`, `conversation`, `solicitation`, `negotiation`, `committed`, `funded`, `stewarding`, `declined`, `withdrawn` |
| governmentStage | enum | | — | `rfp_watching`, `application_in_progress`, `submitted`, `under_review`, `awarded`, `not_awarded` |
| expectedCloseDate | timestamp | | — | |
| fiscalYear | text | | — | e.g. `FY2026` (July 2025 – June 2026) |
| rollForwardCount | integer | | `0` | How many times this opp has been pushed to next FY |
| loiDeadline | timestamp | | — | Letter of Intent deadline |
| loiSubmitted | boolean | | `false` | |
| proposalDeadline | timestamp | | — | |
| proposalSubmitted | boolean | | `false` | |
| decisionExpectedDate | timestamp | | — | |
| askAmount | numeric(15,2) | | — | The specific ask (may differ from amountExpected) |
| askRationale | text | | — | |
| pledgeId | text | | — | Soft link to pledges (no FK constraint) |
| notes | text | | — | |
| createdAt | timestamp | ✓ | now() | |
| updatedAt | timestamp | ✓ | now() | |

---

## `pledges`

A multi-year or multi-installment giving commitment.

| Field | Type | Req | Default | Notes / Options |
|---|---|---|---|---|
| id | text | ✓ | — | Primary key |
| name | text | ✓ | — | e.g. "Smith 3-Year Pledge" |
| fund | enum | ✓ | — | See [fund](#fund) |
| individualId | text | | — | FK → individuals |
| householdId | text | | — | FK → households |
| fundingEntityId | text | | — | FK → funding_entities |
| totalCommittedAmount | numeric(15,2) | ✓ | — | Full pledge value across all installments |
| currency | text | ✓ | `USD` | |
| pledgeDate | timestamp | ✓ | — | Date of commitment |
| numberOfInstallments | integer | ✓ | `1` | |
| status | enum | ✓ | `active` | `active`, `completed`, `revised`, `defaulted` |
| amountReceived | numeric(15,2) | | `0` | Auto-updated as installments are paid |
| legalDocumentOnFile | boolean | | `false` | |
| notes | text | | — | |
| createdAt | timestamp | ✓ | now() | |
| updatedAt | timestamp | ✓ | now() | |

---

## `pledge_installments`

Individual payment schedule entries for a pledge.

| Field | Type | Req | Default | Notes / Options |
|---|---|---|---|---|
| id | text | ✓ | — | Primary key |
| pledgeId | text | ✓ | — | FK → pledges (cascade delete) |
| installmentNumber | integer | ✓ | — | 1-based sequence number |
| dueDate | timestamp | ✓ | — | |
| amount | numeric(15,2) | ✓ | — | |
| status | enum | ✓ | `scheduled` | `scheduled`, `paid`, `overdue`, `waived` |
| paidDate | timestamp | | — | Set when status → paid |
| notes | text | | — | |
| createdAt | timestamp | ✓ | now() | |
| updatedAt | timestamp | ✓ | now() | |

---

## `gifts`

A recorded cash receipt (may be tied to a pledge installment).

| Field | Type | Req | Default | Notes / Options |
|---|---|---|---|---|
| id | text | ✓ | — | Primary key |
| fund | enum | ✓ | — | See [fund](#fund) |
| individualId | text | | — | FK → individuals |
| householdId | text | | — | FK → households |
| fundingEntityId | text | | — | FK → funding_entities |
| pledgeId | text | | — | FK → pledges |
| amount | numeric(15,2) | ✓ | — | |
| cashReceivedDate | timestamp | ✓ | — | Date money hit the bank |
| paymentMethod | enum | | — | `check`, `wire`, `ach`, `credit_card`, `stock`, `daf_grant`, `in_kind`, `other` |
| checkNumber | text | | — | |
| reconciled | boolean | | `false` | Marked true after finance reconciliation |
| directToSchoolPassthrough | boolean | | `false` | Gift sent directly to a school, not through central office |
| softCreditIndividualId | text | | — | FK → individuals; donor to receive soft credit |
| softCreditNotes | text | | — | |
| fiscalYear | text | | — | e.g. `FY2026` |
| notes | text | | — | |
| createdAt | timestamp | ✓ | now() | |
| updatedAt | timestamp | ✓ | now() | |

---

## `moves`

A logged donor interaction or cultivation action.

| Field | Type | Req | Default | Notes / Options |
|---|---|---|---|---|
| id | text | ✓ | — | Primary key |
| subject | text | ✓ | — | Short description / title |
| moveType | enum | ✓ | — | `email`, `call`, `meeting`, `site_visit`, `event`, `letter`, `proposal_submission`, `report`, `other` |
| moveLevel | enum | ✓ | — | `individual`, `household`, `funding_entity` |
| date | timestamp | ✓ | — | Date the interaction occurred |
| individualId | text | | — | FK → individuals |
| householdId | text | | — | FK → households |
| fundingEntityId | text | | — | FK → funding_entities |
| opportunityId | text | | — | FK → opportunities |
| staffUserId | text | | — | Soft link to users (no FK constraint) |
| summary | text | | — | Full notes on what was discussed |
| outcome | text | | — | Result / outcome of the interaction |
| nextStep | text | | — | Description of the next planned action |
| nextStepDueDate | timestamp | | — | Deadline for the next step |
| isDraft | boolean | | `false` | Draft moves are not shown in activity feeds |
| source | enum | | `manual` | `manual`, `gmail`, `calendar` |
| createdAt | timestamp | ✓ | now() | |
| updatedAt | timestamp | ✓ | now() | |

---

## `move_participants`

Junction table recording which staff members participated in a move.

| Field | Type | Req | Default | Notes / Options |
|---|---|---|---|---|
| id | text | ✓ | — | Primary key |
| moveId | text | ✓ | — | FK → moves (cascade delete) |
| userId | text | ✓ | — | Soft link to users (no FK constraint) |
| createdAt | timestamp | ✓ | now() | |

---

*Last updated: April 2026. Source of truth: `lib/db/src/schema/*.ts`.*
