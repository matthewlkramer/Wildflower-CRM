import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";
import { nanoid } from "nanoid";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

const {
  users,
  households,
  householdMembers,
  individuals,
  individualRelationships,
  organizations,
  fundingEntities,
  affiliations,
  campaigns,
  opportunities,
  pledges,
  pledgeInstallments,
  gifts,
  giftAllocations,
  giftSoftCredits,
  moves,
  tags,
  tagLinks,
  contactEmails,
  contactPhones,
  contactAddresses,
} = schema;

function id() {
  return nanoid();
}

async function main() {
  console.log("Seeding database...");

  await db.delete(tagLinks);
  await db.delete(tags);
  await db.delete(contactEmails);
  await db.delete(contactPhones);
  await db.delete(contactAddresses);
  await db.delete(giftSoftCredits);
  await db.delete(giftAllocations);
  await db.delete(moves);
  await db.delete(gifts);
  await db.delete(pledgeInstallments);
  await db.delete(pledges);
  await db.delete(opportunities);
  await db.delete(campaigns);
  await db.delete(affiliations);
  await db.delete(individualRelationships);
  await db.delete(householdMembers);
  await db.delete(individuals);
  await db.delete(households);
  await db.delete(fundingEntities);
  await db.delete(organizations);
  await db.delete(users);

  const [u1, u2, u3] = await db.insert(users).values([
    { id: id(), clerkId: "demo_alice", email: "alice@wildflowerschools.org", firstName: "Alice", lastName: "Okafor", displayName: "Alice Okafor", role: "admin" as const, defaultFund: "general_operating" as const },
    { id: id(), clerkId: "demo_ben", email: "ben@wildflowerschools.org", firstName: "Ben", lastName: "Reston", displayName: "Ben Reston", role: "team_member" as const, defaultFund: "seed_fund" as const },
    { id: id(), clerkId: "demo_carla", email: "carla@wildflowerschools.org", firstName: "Carla", lastName: "Santos", displayName: "Carla Santos", role: "finance" as const },
  ]).returning();

  const [hh1, hh2] = await db.insert(households).values([
    { id: id(), name: "Chen-Nakamura Household", primaryOwnerUserId: u1.id, status: "active" as const, formationDate: new Date("2018-09-01"), notes: "High-capacity couple, both in tech. Met at FY24 gala." },
    { id: id(), name: "Okonkwo Family", primaryOwnerUserId: u2.id, status: "active" as const, notes: "Strong advocates. Introduced by board member Dr. Eze." },
  ]).returning();

  const [org1, org2] = await db.insert(organizations).values([
    { id: id(), name: "TechVentures Capital", website: "https://techventures.com", industry: "Venture Capital", isPhilanthropic: false, notes: "Maya's employer." },
    { id: id(), name: "Montessori Alliance", website: "https://montessorialliance.org", industry: "Education Nonprofit", isPhilanthropic: false, notes: "Priya's employer; aligned mission." },
  ]).returning();

  const [ind1, ind2, ind3, ind4, ind5] = await db.insert(individuals).values([
    { id: id(), firstName: "Maya", lastName: "Chen-Nakamura", pronouns: "she/her", relationshipOwnerUserId: u1.id, strategyUserId: u1.id, donorCultivationStage: "in_relationship" as const, enthusiasm: "advocate" as const, capacityRating: "tier_250k_1m" as const, lastMoveDate: new Date("2026-04-01"), lastGiftDate: new Date("2025-12-15"), lastGiftAmount: "50000", totalGiving: "175000", notes: "Lead donor on Seed Fund expansion." },
    { id: id(), firstName: "Kenji", lastName: "Nakamura", pronouns: "he/him", relationshipOwnerUserId: u1.id, donorCultivationStage: "connected" as const, enthusiasm: "supportive" as const, capacityRating: "tier_250k_1m" as const, lastMoveDate: new Date("2026-03-15"), totalGiving: "50000" },
    { id: id(), firstName: "Adaeze", lastName: "Okonkwo", pronouns: "she/her", relationshipOwnerUserId: u2.id, donorCultivationStage: "in_relationship" as const, enthusiasm: "advocate" as const, capacityRating: "tier_50k_250k" as const, lastMoveDate: new Date("2026-04-10"), lastGiftDate: new Date("2025-11-01"), lastGiftAmount: "25000", totalGiving: "75000" },
    { id: id(), firstName: "James", lastName: "Whitfield", pronouns: "he/him", relationshipOwnerUserId: u2.id, donorCultivationStage: "qualified" as const, enthusiasm: "warm" as const, capacityRating: "tier_50k_250k" as const, lastMoveDate: new Date("2026-02-20"), totalGiving: "0" },
    { id: id(), firstName: "Priya", lastName: "Sharma", pronouns: "she/her", relationshipOwnerUserId: u1.id, donorCultivationStage: "connected" as const, enthusiasm: "supportive" as const, capacityRating: "tier_10k_50k" as const, lastMoveDate: new Date("2026-03-28"), lastGiftDate: new Date("2025-06-15"), lastGiftAmount: "10000", totalGiving: "35000" },
  ]).returning();

  await db.insert(contactEmails).values([
    { id: id(), ownerType: "individual" as const, ownerId: ind1.id, email: "maya@techventures.com", label: "work" as const, isPrimary: true },
    { id: id(), ownerType: "individual" as const, ownerId: ind1.id, email: "maya.cn@gmail.com", label: "personal" as const, isPrimary: false },
    { id: id(), ownerType: "individual" as const, ownerId: ind2.id, email: "kenji@nakamura.io", label: "personal" as const, isPrimary: true },
    { id: id(), ownerType: "individual" as const, ownerId: ind3.id, email: "adaeze.okonkwo@gmail.com", label: "personal" as const, isPrimary: true },
    { id: id(), ownerType: "individual" as const, ownerId: ind4.id, email: "j.whitfield@prospectpartners.com", label: "work" as const, isPrimary: true },
    { id: id(), ownerType: "individual" as const, ownerId: ind5.id, email: "priya.sharma@montessorialliance.org", label: "work" as const, isPrimary: true },
  ]);

  await db.insert(contactPhones).values([
    { id: id(), ownerType: "individual" as const, ownerId: ind1.id, phone: "415-555-0101", label: "mobile" as const, isPrimary: true },
    { id: id(), ownerType: "individual" as const, ownerId: ind3.id, phone: "212-555-0202", label: "mobile" as const, isPrimary: true },
  ]);

  await db.insert(contactAddresses).values([
    { id: id(), ownerType: "individual" as const, ownerId: ind1.id, line1: "100 Market St, Apt 4B", city: "San Francisco", state: "CA", postalCode: "94103", metroArea: "San Francisco Bay Area", label: "home" as const, isPrimary: true },
    { id: id(), ownerType: "individual" as const, ownerId: ind2.id, line1: "100 Market St, Apt 4B", city: "San Francisco", state: "CA", postalCode: "94103", metroArea: "San Francisco Bay Area", label: "home" as const, isPrimary: true },
    { id: id(), ownerType: "individual" as const, ownerId: ind3.id, line1: "55 W 22nd St", city: "New York", state: "NY", postalCode: "10010", metroArea: "New York City", label: "home" as const, isPrimary: true },
    { id: id(), ownerType: "individual" as const, ownerId: ind4.id, line1: "200 Beacon St", city: "Boston", state: "MA", postalCode: "02116", metroArea: "Boston", label: "home" as const, isPrimary: true },
    { id: id(), ownerType: "individual" as const, ownerId: ind5.id, line1: "1500 N Lake Shore Dr", city: "Chicago", state: "IL", postalCode: "60610", metroArea: "Chicago", label: "home" as const, isPrimary: true },
  ]);

  await db.insert(householdMembers).values([
    { id: id(), householdId: hh1.id, individualId: ind1.id, role: "primary" as const, startDate: "2018-09-01", isCurrent: true },
    { id: id(), householdId: hh1.id, individualId: ind2.id, role: "spouse_partner" as const, startDate: "2018-09-01", isCurrent: true },
    { id: id(), householdId: hh2.id, individualId: ind3.id, role: "primary" as const, isCurrent: true },
  ]);

  await db.insert(individualRelationships).values([
    { id: id(), fromIndividualId: ind1.id, toIndividualId: ind2.id, relationshipType: "spouse" as const, startDate: "2018-09-01", isCurrent: true },
  ]);

  const [fe1, fe2, fe3] = await db.insert(fundingEntities).values([
    { id: id(), legalName: "Berkshire Education Foundation", displayName: "Berkshire Ed Foundation", subtype: "institutional_foundation" as const, primaryContactId: ind4.id, relationshipOwnerUserId: u1.id, institutionalCultivationStage: "proposal" as const, enthusiasm: "warm", typicalGrantSizeMin: "50000", typicalGrantSizeMax: "250000", totalGiving: "150000", lastGiftDate: new Date("2025-03-01"), notes: "Typically funds over 2-year cycles. LOI due June 1." },
    { id: id(), legalName: "Wildberry Family Foundation", subtype: "family_foundation" as const, primaryContactId: ind5.id, relationshipOwnerUserId: u2.id, institutionalCultivationStage: "funded" as const, enthusiasm: "supportive", typicalGrantSizeMin: "10000", typicalGrantSizeMax: "50000", totalGiving: "85000", lastGiftDate: new Date("2025-09-15"), notes: "Repeat funder. Focus on equity and access." },
    { id: id(), legalName: "US Dept of Education - Innovation & Early Learning", displayName: "Dept of Ed - Early Learning", subtype: "government_agency" as const, relationshipOwnerUserId: u1.id, governmentCultivationStage: "rfp_active" as const, typicalGrantSizeMin: "200000", typicalGrantSizeMax: "1000000", totalGiving: "0", notes: "FY26 RFP expected Q4." },
  ]).returning();

  await db.insert(contactEmails).values([
    { id: id(), ownerType: "funding_entity" as const, ownerId: fe1.id, email: "grants@berkshireed.org", label: "work" as const, isPrimary: true },
    { id: id(), ownerType: "funding_entity" as const, ownerId: fe2.id, email: "info@wildberryfamily.org", label: "work" as const, isPrimary: true },
  ]);

  await db.insert(contactAddresses).values([
    { id: id(), ownerType: "funding_entity" as const, ownerId: fe1.id, line1: "75 Tremont St", city: "Boston", state: "MA", postalCode: "02108", metroArea: "Boston", label: "mailing" as const, isPrimary: true },
    { id: id(), ownerType: "funding_entity" as const, ownerId: fe3.id, line1: "400 Maryland Ave SW", city: "Washington", state: "DC", postalCode: "20202", metroArea: "Washington DC", label: "mailing" as const, isPrimary: true },
  ]);

  await db.insert(affiliations).values([
    { id: id(), individualId: ind4.id, fundingEntityId: fe1.id, role: "Program Officer", affiliationType: "employee" as const, startDate: "2020-01-01", isCurrent: true },
    { id: id(), individualId: ind5.id, fundingEntityId: fe2.id, role: "Trustee", affiliationType: "trustee" as const, isCurrent: true },
    { id: id(), individualId: ind1.id, organizationId: org1.id, role: "Partner", affiliationType: "employee" as const, startDate: "2017-03-01", isCurrent: true },
    { id: id(), individualId: ind5.id, organizationId: org2.id, role: "Director of Partnerships", affiliationType: "employee" as const, isCurrent: true },
  ]);

  const [camp1, camp2] = await db.insert(campaigns).values([
    { id: id(), name: "FY26 Annual Fund", fund: "general_operating" as const, fiscalYear: "FY26" as const, startDate: "2025-07-01", endDate: "2026-06-30", goalAmount: "500000", description: "Unrestricted operating support for FY26.", isActive: true },
    { id: id(), name: "Black Wildflowers Fall Drive 2025", fund: "black_wildflowers" as const, fiscalYear: "FY26" as const, startDate: "2025-09-01", endDate: "2025-12-31", goalAmount: "100000", description: "Targeted fall drive for Black Wildflowers Fund.", isActive: false },
  ]).returning();

  const fy = "FY26" as const;
  const [opp1, opp2, opp3, opp4, opp5, opp6] = await db.insert(opportunities).values([
    { id: id(), name: "Maya Chen-Nakamura – Seed Fund FY26", subtype: "ongoing_rolling" as const, donorType: "individual" as const, individualId: ind1.id, ownerUserId: u1.id, fund: "seed_fund" as const, amountExpected: "75000", probability: 85, probabilityOverridden: true, stage: "negotiation" as const, expectedCloseDate: new Date("2026-06-30"), fiscalYear: "FY26" as const, askAmount: "75000", askRationale: "Continuation of FY25 gift with 50% increase." },
    { id: id(), name: "Okonkwo – Black Wildflowers Fund", subtype: "targeted_deadline" as const, donorType: "household" as const, householdId: hh2.id, ownerUserId: u2.id, fund: "black_wildflowers" as const, amountExpected: "25000", probability: 70, stage: "solicitation" as const, expectedCloseDate: new Date("2026-05-15"), fiscalYear: "FY26" as const, askAmount: "25000", campaignId: camp2.id },
    { id: id(), name: "Berkshire Ed Foundation – General Operating", subtype: "targeted_deadline" as const, donorType: "institutional_foundation" as const, fundingEntityId: fe1.id, ownerUserId: u1.id, fund: "general_operating" as const, amountExpected: "150000", probability: 55, stage: "conversation" as const, expectedCloseDate: new Date("2026-09-01"), fiscalYear: "FY26" as const, loiDeadline: new Date("2026-06-01"), proposalDeadline: new Date("2026-08-01") },
    { id: id(), name: "Wildberry Family – Seed Fund Renewal", subtype: "ongoing_rolling" as const, donorType: "family_foundation" as const, fundingEntityId: fe2.id, ownerUserId: u2.id, fund: "seed_fund" as const, amountExpected: "35000", probability: 90, probabilityOverridden: true, stage: "committed" as const, expectedCloseDate: new Date("2026-07-01"), fiscalYear: "FY26" as const },
    { id: id(), name: "James Whitfield – General Operating Discovery", subtype: "ongoing_rolling" as const, donorType: "individual" as const, individualId: ind4.id, ownerUserId: u2.id, fund: "general_operating" as const, amountExpected: "50000", probability: 30, stage: "conversation" as const, expectedCloseDate: new Date("2026-08-30"), fiscalYear: "FY26" as const, campaignId: camp1.id },
    { id: id(), name: "Dept of Ed – Early Learning Innovation RFP", subtype: "rfp_proposal" as const, donorType: "government_rfp" as const, fundingEntityId: fe3.id, ownerUserId: u1.id, fund: "general_operating" as const, amountExpected: "500000", probability: 20, probabilityOverridden: true, stage: "pre_conversation" as const, governmentStage: "application_in_progress" as const, expectedCloseDate: new Date("2026-12-15"), fiscalYear: "FY26" as const, proposalDeadline: new Date("2026-10-15"), loiDeadline: new Date("2026-08-30"), notes: "Multi-year potential." },
  ]).returning();

  const [pledge1] = await db.insert(pledges).values([
    { id: id(), name: "Maya Chen-Nakamura 3-Year Seed Fund Pledge", fund: "seed_fund" as const, individualId: ind1.id, totalCommittedAmount: "225000", pledgeDate: new Date("2024-01-15"), numberOfInstallments: 3, status: "active" as const, amountReceived: "150000", legalDocumentOnFile: true, notes: "Year 3 installment due Q4 FY26." },
  ]).returning();

  await db.insert(pledgeInstallments).values([
    { id: id(), pledgeId: pledge1.id, installmentNumber: 1, dueDate: new Date("2024-06-30"), amount: "75000", status: "paid" as const, paidDate: new Date("2024-06-15") },
    { id: id(), pledgeId: pledge1.id, installmentNumber: 2, dueDate: new Date("2025-06-30"), amount: "75000", status: "paid" as const, paidDate: new Date("2025-06-20") },
    { id: id(), pledgeId: pledge1.id, installmentNumber: 3, dueDate: new Date("2026-06-30"), amount: "75000", status: "scheduled" as const },
  ]);

  const [g1, g2, g3, g4] = await db.insert(gifts).values([
    { id: id(), individualId: ind1.id, pledgeId: pledge1.id, amount: "75000", currency: "USD", cashReceivedDate: new Date("2025-06-20"), paymentMethod: "wire" as const, reconciled: true },
    { id: id(), individualId: ind3.id, amount: "25000", currency: "USD", cashReceivedDate: new Date("2025-11-01"), paymentMethod: "check" as const, reconciled: true, campaignId: camp2.id },
    { id: id(), fundingEntityId: fe2.id, amount: "35000", currency: "USD", cashReceivedDate: new Date("2025-09-15"), paymentMethod: "ach" as const, reconciled: true },
    { id: id(), individualId: ind5.id, amount: "10000", currency: "USD", cashReceivedDate: new Date("2025-06-15"), paymentMethod: "check" as const, reconciled: false, campaignId: camp1.id },
  ]).returning();

  await db.insert(giftAllocations).values([
    { id: id(), giftId: g1.id, fund: "seed_fund" as const, amount: "75000", fiscalYear: "FY25" as const },
    { id: id(), giftId: g2.id, fund: "black_wildflowers" as const, amount: "25000", fiscalYear: "FY26" as const },
    { id: id(), giftId: g3.id, fund: "seed_fund" as const, amount: "35000", fiscalYear: "FY26" as const },
    { id: id(), giftId: g4.id, fund: "general_operating" as const, amount: "10000", fiscalYear: "FY25" as const },
  ]);

  await db.insert(giftSoftCredits).values([
    { id: id(), giftId: g1.id, individualId: ind2.id, creditType: "spouse" as const, percentage: "50.00", notes: "Joint household gift" },
  ]);

  await db.insert(moves).values([
    { id: id(), subject: "Quarterly impact call – Maya Chen-Nakamura", moveType: "call" as const, moveLevel: "individual" as const, individualId: ind1.id, opportunityId: opp1.id, date: new Date("2026-04-01"), summary: "Reviewed school expansion in Austin and Denver. Maya confirmed intention to renew at $75K.", outcome: "Positive – will proceed with formal ask in April", nextStep: "Send updated investment memo and formal ask letter", nextStepDueDate: new Date("2026-04-18"), isDraft: false, source: "manual" as const },
    { id: id(), subject: "Introductory meeting – James Whitfield", moveType: "meeting" as const, moveLevel: "individual" as const, individualId: ind4.id, opportunityId: opp5.id, date: new Date("2026-02-20"), summary: "First in-person meeting. No prior Wildflower exposure. Wants outcome data.", outcome: "Warm – requested follow-up with data package", nextStep: "Send outcome data package and schedule site visit", nextStepDueDate: new Date("2026-03-10"), isDraft: false, source: "manual" as const },
    { id: id(), subject: "Annual report delivery – Okonkwo family", moveType: "email" as const, moveLevel: "household" as const, householdId: hh2.id, date: new Date("2026-04-10"), summary: "Sent FY25 annual report. Adaeze replied expressing pride in the Black Wildflowers fund.", outcome: "Strong – ready for formal ask conversation", nextStep: "Schedule ask meeting for May", nextStepDueDate: new Date("2026-04-25"), isDraft: false, source: "gmail" as const },
    { id: id(), subject: "Berkshire Ed LOI prep call", moveType: "call" as const, moveLevel: "funding_entity" as const, fundingEntityId: fe1.id, opportunityId: opp3.id, date: new Date("2026-03-28"), summary: "Program director confirmed interest in multi-year operating support. LOI should emphasize equity outcomes.", outcome: "Constructive – clear direction for LOI", nextStep: "Draft LOI and share with team for review", nextStepDueDate: new Date("2026-05-15"), isDraft: false, source: "manual" as const },
  ]);

  const [t1, t2, t3] = await db.insert(tags).values([
    { id: id(), name: "wildflower champion", category: "donor_segment", color: "#7c3aed" },
    { id: id(), name: "national individual giving prospect", category: "donor_segment", color: "#2563eb" },
    { id: id(), name: "FY26 spring appeal", category: "campaign", color: "#16a34a" },
  ]).returning();

  await db.insert(tagLinks).values([
    { id: id(), tagId: t1.id, entityType: "individual" as const, entityId: ind1.id, createdByUserId: u1.id },
    { id: id(), tagId: t2.id, entityType: "individual" as const, entityId: ind4.id, createdByUserId: u2.id },
    { id: id(), tagId: t3.id, entityType: "household" as const, entityId: hh2.id, createdByUserId: u2.id },
  ]);

  console.log("Seed complete!");
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
