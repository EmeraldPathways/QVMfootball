CREATE TABLE `data_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`endpoint` text NOT NULL,
	`content_hash` text NOT NULL,
	`payload` text NOT NULL,
	`captured_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decision_replays` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fixture_id` integer,
	`decision` text NOT NULL,
	`model_version` text NOT NULL,
	`data_snapshot_ids` text,
	`deterministic_checks` text NOT NULL,
	`agent_reports` text,
	`approval_status` text DEFAULT 'NOT_REQUIRED' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `experiment_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`experiment_name` text NOT NULL,
	`champion_version` text NOT NULL,
	`challenger_version` text NOT NULL,
	`metrics_json` text NOT NULL,
	`status` text DEFAULT 'COMPLETED' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fixture_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fixture_id` integer NOT NULL,
	`minute` integer NOT NULL,
	`event_type` text NOT NULL,
	`team_id` integer,
	`player_id` integer,
	`xg` real,
	`payload` text,
	`recorded_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `players` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` integer NOT NULL,
	`name` text NOT NULL,
	`position` text,
	`expected_minutes` real DEFAULT 0 NOT NULL,
	`attack_rating` real DEFAULT 0 NOT NULL,
	`defence_rating` real DEFAULT 0 NOT NULL,
	`availability` text DEFAULT 'UNKNOWN' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `portfolio_scenarios` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scenario_name` text NOT NULL,
	`assumptions_json` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
