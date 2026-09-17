CREATE TABLE `availability_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fixture_id` integer NOT NULL,
	`team_id` integer NOT NULL,
	`player_id` integer,
	`player_name` text NOT NULL,
	`status` text DEFAULT 'UNKNOWN' NOT NULL,
	`expected_minutes` real DEFAULT 0 NOT NULL,
	`source` text NOT NULL,
	`confidence` real DEFAULT 0.5 NOT NULL,
	`captured_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`available_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`payload` text,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_availability_fixture_id` ON `availability_snapshots` (`fixture_id`);--> statement-breakpoint
CREATE INDEX `idx_availability_team_id` ON `availability_snapshots` (`team_id`);--> statement-breakpoint
CREATE INDEX `idx_availability_captured_at` ON `availability_snapshots` (`captured_at`);--> statement-breakpoint
CREATE TABLE `data_source_health` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'NOT_CONFIGURED' NOT NULL,
	`last_success_at` text,
	`last_attempt_at` text,
	`records_updated` integer DEFAULT 0 NOT NULL,
	`message` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_data_source_health_source` ON `data_source_health` (`source`);--> statement-breakpoint
CREATE TABLE `fixture_features` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fixture_id` integer NOT NULL,
	`source` text NOT NULL,
	`captured_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`available_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`home_xg` real,
	`away_xg` real,
	`home_shots` integer,
	`away_shots` integer,
	`home_big_chances` integer,
	`away_big_chances` integer,
	`home_rest_days` real,
	`away_rest_days` real,
	`travel_km` real,
	`weather_json` text,
	`payload` text,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fixture_features_fixture_id` ON `fixture_features` (`fixture_id`);--> statement-breakpoint
CREATE INDEX `idx_fixture_features_captured_at` ON `fixture_features` (`captured_at`);--> statement-breakpoint
ALTER TABLE `data_snapshots` ADD `available_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL;--> statement-breakpoint
ALTER TABLE `data_snapshots` ADD `status` text DEFAULT 'VALID' NOT NULL;--> statement-breakpoint
ALTER TABLE `data_snapshots` ADD `freshness_seconds` integer;--> statement-breakpoint
ALTER TABLE `market_quotes` ADD `best_home_odds` real;--> statement-breakpoint
ALTER TABLE `market_quotes` ADD `best_draw_odds` real;--> statement-breakpoint
ALTER TABLE `market_quotes` ADD `best_away_odds` real;--> statement-breakpoint
ALTER TABLE `market_quotes` ADD `is_closing` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `market_quotes` ADD `source_confidence` real DEFAULT 0.5 NOT NULL;