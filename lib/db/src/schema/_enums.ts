import { pgEnum } from "drizzle-orm/pg-core";

export const regionTypeEnum = pgEnum("region_type", [
  "state",
  "metro_area",
  "city",
  "neighborhood",
  "region_within_state",
  "multi_state_region",
  "country",
  "continent",
]);

export const entityRoleTypeEnum = pgEnum("entity_role_type", [
  "funder",
  "non_funding_organization",
  "payment_intermediary",
  "household",
]);

export const contactCurrentEnum = pgEnum("contact_current", [
  "active",
  "inactive",
]);

export const peopleRoleCurrentEnum = pgEnum("people_role_current", [
  "current",
  "past",
]);

export const opportunityStatusEnum = pgEnum("opportunity_status", [
  "open",
  "won",
  "dormant",
  "lost",
]);

export const pledgeAllocationStatusEnum = pgEnum("pledge_allocation_status", [
  "working",
  "committed",
  "superseded",
  "committed_with_conditions",
]);

export const paymentIntermediaryTypeEnum = pgEnum("payment_intermediary_type", [
  "daf",
  "giving_platform",
]);
