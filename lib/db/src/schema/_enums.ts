import { pgEnum } from "drizzle-orm/pg-core";

export const fiscalYearEnum = pgEnum("fiscal_year", [
  "FY23",
  "FY24",
  "FY25",
  "FY26",
  "FY27",
  "FY28",
  "FY29",
  "FY30",
]);

export const cultivationTeamRoleEnum = pgEnum("cultivation_team_role", [
  "relationship_owner",
  "strategy",
  "support",
  "primary_solicitor",
]);

export const fundingEntityStatusEnum = pgEnum("funding_entity_status", [
  "active",
  "defunct",
  "merged",
]);
