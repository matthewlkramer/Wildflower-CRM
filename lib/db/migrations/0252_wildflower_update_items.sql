CREATE TYPE "wildflower_update_date_precision" AS ENUM (
  'exact', 'month', 'year', 'season', 'date_range', 'unknown'
);
CREATE TYPE "wildflower_update_source_type" AS ENUM (
  'sent_newsletter', 'published_article', 'donor_proposal', 'draft'
);
CREATE TYPE "wildflower_update_status" AS ENUM (
  'completed', 'reported_progress', 'work_in_progress', 'proposed_work'
);
CREATE TYPE "wildflower_update_preparation_status" AS ENUM (
  'eligible', 'hold_for_confirmation'
);

CREATE TABLE "wildflower_update_items" (
  "id" text PRIMARY KEY NOT NULL,
  "title" text NOT NULL,
  "details" text NOT NULL,
  "date_precision" "wildflower_update_date_precision" DEFAULT 'unknown' NOT NULL,
  "event_start_date" date,
  "event_end_date" date,
  "event_year" integer,
  "event_month" integer,
  "event_season" text,
  "status" "wildflower_update_status" NOT NULL,
  "preparation_status" "wildflower_update_preparation_status" DEFAULT 'eligible' NOT NULL,
  "thematic_tags" text[] DEFAULT '{}' NOT NULL,
  "age_tags" text[] DEFAULT '{}' NOT NULL,
  "governance_tags" text[] DEFAULT '{}' NOT NULL,
  "funding_region_ids" text[] DEFAULT '{}' NOT NULL,
  "normalized_headline" text NOT NULL,
  "event_date_key" text NOT NULL,
  "archived_at" timestamptz,
  "archived_by_user_id" text REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "wildflower_update_items_created_at_idx" ON "wildflower_update_items" ("created_at");
CREATE INDEX "wildflower_update_items_event_start_date_idx" ON "wildflower_update_items" ("event_start_date");
CREATE INDEX "wildflower_update_items_status_idx" ON "wildflower_update_items" ("status");
CREATE INDEX "wildflower_update_items_archived_at_idx" ON "wildflower_update_items" ("archived_at");
CREATE INDEX "wildflower_update_items_thematic_tags_gin_idx" ON "wildflower_update_items" USING gin ("thematic_tags");
CREATE INDEX "wildflower_update_items_age_tags_gin_idx" ON "wildflower_update_items" USING gin ("age_tags");
CREATE INDEX "wildflower_update_items_governance_tags_gin_idx" ON "wildflower_update_items" USING gin ("governance_tags");
CREATE INDEX "wildflower_update_items_funding_region_ids_gin_idx" ON "wildflower_update_items" USING gin ("funding_region_ids");
CREATE UNIQUE INDEX "wildflower_update_items_identity_uq" ON "wildflower_update_items" ("normalized_headline", "event_date_key");

CREATE TABLE "wildflower_update_sources" (
  "id" text PRIMARY KEY NOT NULL,
  "item_id" text NOT NULL REFERENCES "wildflower_update_items"("id") ON DELETE CASCADE,
  "source_type" "wildflower_update_source_type" NOT NULL,
  "title" text NOT NULL,
  "url" text NOT NULL,
  "normalized_url" text NOT NULL,
  "publication_date_precision" "wildflower_update_date_precision" DEFAULT 'unknown' NOT NULL,
  "publication_date" date,
  "publication_end_date" date,
  "publication_year" integer,
  "publication_month" integer,
  "publication_season" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "wildflower_update_sources_item_id_idx" ON "wildflower_update_sources" ("item_id");
CREATE UNIQUE INDEX "wildflower_update_sources_item_url_uq" ON "wildflower_update_sources" ("item_id", "normalized_url");

CREATE TABLE "wildflower_update_related_links" (
  "id" text PRIMARY KEY NOT NULL,
  "item_id" text NOT NULL REFERENCES "wildflower_update_items"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "url" text NOT NULL,
  "normalized_url" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX "wildflower_update_related_links_item_id_idx" ON "wildflower_update_related_links" ("item_id");
CREATE UNIQUE INDEX "wildflower_update_related_links_item_url_uq" ON "wildflower_update_related_links" ("item_id", "normalized_url");