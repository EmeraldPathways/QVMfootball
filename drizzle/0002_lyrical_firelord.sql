CREATE TABLE `calibration_buckets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_version` text NOT NULL,
	`outcome_class` text NOT NULL,
	`bucket` integer NOT NULL,
	`prediction_count` integer DEFAULT 0 NOT NULL,
	`predicted_probability` real DEFAULT 0 NOT NULL,
	`observed_frequency` real DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_calibration_model_bucket` ON `calibration_buckets` (`model_version`,`bucket`);--> statement-breakpoint
CREATE TABLE `model_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`feature_set` text DEFAULT 'goals_home_away' NOT NULL,
	`parameters_json` text,
	`git_commit` text,
	`status` text DEFAULT 'CHALLENGER' NOT NULL,
	`is_active` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_model_versions_active` ON `model_versions` (`is_active`);--> statement-breakpoint
CREATE TABLE `worker_heartbeats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`worker_name` text NOT NULL,
	`status` text DEFAULT 'STARTING' NOT NULL,
	`last_started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_finished_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_error` text,
	`cycles_completed` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE `market_quotes` ADD `market_type` text DEFAULT '1X2' NOT NULL;--> statement-breakpoint
ALTER TABLE `market_quotes` ADD `bookmaker_count` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `market_quotes` ADD `consensus_home_prob` real;--> statement-breakpoint
ALTER TABLE `market_quotes` ADD `consensus_draw_prob` real;--> statement-breakpoint
ALTER TABLE `market_quotes` ADD `consensus_away_prob` real;--> statement-breakpoint
ALTER TABLE `market_quotes` ADD `overround` real;--> statement-breakpoint
ALTER TABLE `predictions` ADD `calibrated_home_prob` real;--> statement-breakpoint
ALTER TABLE `predictions` ADD `calibrated_draw_prob` real;--> statement-breakpoint
ALTER TABLE `predictions` ADD `calibrated_away_prob` real;--> statement-breakpoint
ALTER TABLE `predictions` ADD `model_version` text DEFAULT 'dixon-coles-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE `predictions` ADD `grid_size` integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `predictions` ADD `tail_mass` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `predictions` ADD `data_quality_score` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `simulated_bets` ADD `commission_amount` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `simulated_bets` ADD `slippage_pct` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `simulated_bets` ADD `data_quality_score` real DEFAULT 0 NOT NULL;--> statement-breakpoint
