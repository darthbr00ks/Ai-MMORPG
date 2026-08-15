-- Factions: named alliances of characters with a shared color, icon, and leader.
CREATE TYPE "faction_rank" AS ENUM('leader', 'commander', 'captain', 'lieutenant', 'member');--> statement-breakpoint

CREATE TABLE "factions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "color" text NOT NULL,
  "icon" text DEFAULT 'shield' NOT NULL,
  "founded_game_day" integer DEFAULT 0 NOT NULL,
  "leader_id" uuid REFERENCES "characters"("id"),
  "created_at" timestamp DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Faction membership columns on character_state — nullable; NULL means no faction yet.
ALTER TABLE "character_state" ADD COLUMN "faction_id" uuid REFERENCES "factions"("id");--> statement-breakpoint
ALTER TABLE "character_state" ADD COLUMN "faction_rank" "faction_rank";
