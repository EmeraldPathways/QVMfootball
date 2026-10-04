CREATE TABLE `paper_action_receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`action` text NOT NULL,
	`response_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_paper_action_receipts_request_id` ON `paper_action_receipts` (`request_id`);--> statement-breakpoint
CREATE INDEX `idx_paper_action_receipts_created_at` ON `paper_action_receipts` (`created_at`);--> statement-breakpoint
CREATE TABLE `saved_edge_views` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`filters_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_saved_edge_views_name` ON `saved_edge_views` (`name`);--> statement-breakpoint
CREATE INDEX `idx_saved_edge_views_updated_at` ON `saved_edge_views` (`updated_at`);--> statement-breakpoint
ALTER TABLE `model_runs` ADD `evaluation_start` text;--> statement-breakpoint
ALTER TABLE `model_runs` ADD `evaluation_end` text;--> statement-breakpoint
ALTER TABLE `model_runs` ADD `train_cutoff` text;--> statement-breakpoint
ALTER TABLE `model_runs` ADD `leakage_checked` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_simulated_bets_open_identity` ON `simulated_bets` (`fixture_id`,`selection`) WHERE `status` = 'PENDING';
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_worker_heartbeats_worker_name` ON `worker_heartbeats` (`worker_name`);
