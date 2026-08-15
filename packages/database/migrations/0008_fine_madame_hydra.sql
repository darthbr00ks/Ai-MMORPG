DO $$ BEGIN
 CREATE TYPE "public"."faction_rank" AS ENUM('leader', 'commander', 'captain', 'lieutenant', 'member');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "factions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"icon" text DEFAULT 'shield' NOT NULL,
	"founded_game_day" integer DEFAULT 0 NOT NULL,
	"leader_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "character_state" ADD COLUMN "faction_id" uuid;--> statement-breakpoint
ALTER TABLE "character_state" ADD COLUMN "faction_rank" "faction_rank";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "factions" ADD CONSTRAINT "factions_leader_id_characters_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."characters"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "character_state" ADD CONSTRAINT "character_state_faction_id_factions_id_fk" FOREIGN KEY ("faction_id") REFERENCES "public"."factions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
