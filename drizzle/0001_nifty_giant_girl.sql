CREATE TABLE `agent_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent_name` text NOT NULL,
	`role` text NOT NULL,
	`model` text DEFAULT 'Luna Max' NOT NULL,
	`status` text DEFAULT 'RUNNING' NOT NULL,
	`task` text NOT NULL,
	`summary` text,
	`payload` text,
	`started_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_agent_runs_role_status` ON `agent_runs` (`role`,`status`);--> statement-breakpoint
CREATE INDEX `idx_agent_runs_started_at` ON `agent_runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `model_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`model_version` text DEFAULT 'poisson-v2-walk-forward' NOT NULL,
	`evaluation_type` text DEFAULT 'WALK_FORWARD' NOT NULL,
	`fixtures_evaluated` integer DEFAULT 0 NOT NULL,
	`brier_score` real,
	`log_loss` real,
	`hit_rate` real,
	`average_tail_mass` real,
	`roi_pct` real,
	`max_drawdown_pct` real,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_model_runs_created_at` ON `model_runs` (`created_at`);--> statement-breakpoint
ALTER TABLE `simulated_bets` ADD `closing_odds` real;--> statement-breakpoint
ALTER TABLE `simulated_bets` ADD `clv_pct` real;--> statement-breakpoint
