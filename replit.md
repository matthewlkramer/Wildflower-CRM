# Wildflower Fundraising CRM

## Overview

Purpose-built fundraising CRM for Wildflower Schools, replacing Copper. Built as a pnpm workspace monorepo using TypeScript + React + Express + PostgreSQL.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Frontend**: React + Vite + Tailwind CSS + shadcn/ui (port from `PORT` env)
- **API framework**: Express 5 (port 8080)
- **Database**: PostgreSQL + Drizzle ORM
- **Auth**: Clerk (Google SSO restricted to @wildflowerschools.org)
- **Validation**: Zod, drizzle-zod
- **API codegen**: Orval (from OpenAPI spec → React Query hooks + Zod schemas)

## Architecture

```
lib/
  db/              — Drizzle schema, seed script, DB connection
  api-spec/        — OpenAPI spec (openapi.yaml) — source of truth
  api-client-react/ — Generated React Query hooks + response types
  api-zod/         — Generated Zod request/response validators
artifacts/
  api-server/      — Express REST API (port 8080)
  wildflower-crm/  — React frontend (Vite)
```

## Key Commands

```bash
pnpm run typecheck                              # Full typecheck all packages
pnpm --filter @workspace/api-spec run codegen  # Regenerate hooks/Zod from OpenAPI spec
pnpm --filter @workspace/db run push           # Push DB schema changes (dev only)
pnpm --filter @workspace/db run seed           # Re-seed dev data
cd lib/db && pnpm exec tsc -p tsconfig.json    # Rebuild DB declarations (after schema changes)
```

**Important**: After changing the DB schema, always run both `pnpm --filter @workspace/db run push` AND `cd lib/db && pnpm exec tsc -p tsconfig.json` to keep declarations in sync.

## Core Features

- **4 Funds**: General Operating, Seed, Black Wildflowers, Sunlight
- **Donor types**: Individuals, Households, Family Foundations, DAFs, Institutional Foundations, Government RFPs
- **17 frontend pages**: Dashboard, Individuals, Households, Funding Entities, Opportunities (Kanban pipeline), Pledges, Gifts, Moves, Grants Calendar, Projections, + detail pages
- **Moves system**: 4 cultivation tracks, move logging with next-step tracking
- **Pledge installments**: Multi-installment pledge tracking with status
- **3-year FY projections**: Weighted pipeline forecasting by fund
- **Grants calendar**: LOI + proposal deadline tracking with urgency alerts
- **Dashboard**: Open opps, YTD giving, overdue next steps, donors gone quiet, pipeline by fund

## API Response Shapes

All list endpoints return paginated envelopes:
```json
{ "data": [...], "total": 100, "page": 1, "limit": 50 }
```

Dashboard summary (`GET /api/dashboard/summary`) returns `DashboardSummary` type.
Projections (`GET /api/projections/forecast`) returns `ProjectionsForecast` type.
Grants calendar (`GET /api/grants-calendar`) returns `GrantsCalendarEntry[]`.

## Database Schema

8 main tables: `users`, `individuals`, `households`, `funding_entities`, `opportunities`, `pledges`, `pledge_installments`, `gifts`, `moves`, `move_participants`, `funding_entity_people`.

Key schema notes:
- `moves.staffUserId` — staff who logged the move
- `opportunities.loiSubmitted`, `opportunities.proposalSubmitted` — grant tracking
- `opportunities.decisionExpectedDate` — grant decision tracking
- FY label format: `FY2026` = July 2025 – June 2026 (July 1 start)

## Auth

Clerk middleware auto-provisions users on first sign-in (`requireAuth` middleware in API server). All API routes require authentication.

## Seed Data

3 users, 2 households, 5 individuals, 3 funding entities, 6 opportunities, 1 pledge with installments, 4 gifts, 4 moves. Re-run with `pnpm --filter @workspace/db run seed`.
