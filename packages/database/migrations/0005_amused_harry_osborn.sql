CREATE TABLE IF NOT EXISTS "simulation_control" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"speed_multiplier" real DEFAULT 1 NOT NULL,
	"pending_manual_ticks" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
