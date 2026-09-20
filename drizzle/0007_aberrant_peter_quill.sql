PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_predictions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fixture_id` integer NOT NULL,
	`true_home_prob` real NOT NULL,
	`true_draw_prob` real NOT NULL,
	`true_away_prob` real NOT NULL,
	`fair_home_odds` real NOT NULL,
	`fair_draw_odds` real NOT NULL,
	`fair_away_odds` real NOT NULL,
	`calculated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`calibrated_home_prob` real,
	`calibrated_draw_prob` real,
	`calibrated_away_prob` real,
	`model_version` text DEFAULT 'dixon-coles-dynamic-v3' NOT NULL,
	`grid_size` integer DEFAULT 12 NOT NULL,
	`tail_mass` real DEFAULT 0 NOT NULL,
	`data_quality_score` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_predictions`("id", "fixture_id", "true_home_prob", "true_draw_prob", "true_away_prob", "fair_home_odds", "fair_draw_odds", "fair_away_odds", "calculated_at", "calibrated_home_prob", "calibrated_draw_prob", "calibrated_away_prob", "model_version", "grid_size", "tail_mass", "data_quality_score") SELECT "id", "fixture_id", "true_home_prob", "true_draw_prob", "true_away_prob", "fair_home_odds", "fair_draw_odds", "fair_away_odds", "calculated_at", "calibrated_home_prob", "calibrated_draw_prob", "calibrated_away_prob", "model_version", "grid_size", "tail_mass", "data_quality_score" FROM `predictions`;--> statement-breakpoint
DROP TABLE `predictions`;--> statement-breakpoint
ALTER TABLE `__new_predictions` RENAME TO `predictions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_predictions_fixture_id` ON `predictions` (`fixture_id`);--> statement-breakpoint
ALTER TABLE `fixtures` ADD `league` text DEFAULT 'Premier League' NOT NULL;--> statement-breakpoint
