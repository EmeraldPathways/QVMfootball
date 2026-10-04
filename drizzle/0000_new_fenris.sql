CREATE TABLE `app_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fixtures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`home_team_id` integer NOT NULL,
	`away_team_id` integer NOT NULL,
	`match_date` text NOT NULL,
	`home_goals` integer,
	`away_goals` integer,
	`status` text DEFAULT 'SCHEDULED' NOT NULL,
	FOREIGN KEY (`home_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`away_team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_fixtures_match_date` ON `fixtures` (`match_date`);--> statement-breakpoint
CREATE INDEX `idx_fixtures_status` ON `fixtures` (`status`);--> statement-breakpoint
CREATE INDEX `idx_fixtures_teams` ON `fixtures` (`home_team_id`,`away_team_id`);--> statement-breakpoint
CREATE TABLE `market_quotes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fixture_id` integer NOT NULL,
	`provider` text DEFAULT 'Demo market' NOT NULL,
	`home_odds` real NOT NULL,
	`draw_odds` real NOT NULL,
	`away_odds` real NOT NULL,
	`captured_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_market_quotes_fixture_id` ON `market_quotes` (`fixture_id`);--> statement-breakpoint
CREATE INDEX `idx_market_quotes_captured_at` ON `market_quotes` (`captured_at`);--> statement-breakpoint
CREATE TABLE `predictions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fixture_id` integer NOT NULL,
	`true_home_prob` real NOT NULL,
	`true_draw_prob` real NOT NULL,
	`true_away_prob` real NOT NULL,
	`fair_home_odds` real NOT NULL,
	`fair_draw_odds` real NOT NULL,
	`fair_away_odds` real NOT NULL,
	`calculated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_predictions_fixture_id` ON `predictions` (`fixture_id`);--> statement-breakpoint
CREATE TABLE `simulated_bets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`fixture_id` integer NOT NULL,
	`selection` text NOT NULL,
	`market_odds` real NOT NULL,
	`implied_prob` real NOT NULL,
	`true_prob` real NOT NULL,
	`edge_pct` real NOT NULL,
	`stake_amount` real NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`outcome` text,
	`profit_loss` real DEFAULT 0 NOT NULL,
	`placed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`fixture_id`) REFERENCES `fixtures`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_simulated_bets_fixture_status` ON `simulated_bets` (`fixture_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_simulated_bets_placed_at` ON `simulated_bets` (`placed_at`);--> statement-breakpoint
CREATE TABLE `system_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`level` text DEFAULT 'INFO' NOT NULL,
	`message` text NOT NULL,
	`context` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_system_logs_created_at` ON `system_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `team_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`team_id` integer NOT NULL,
	`matches_played` integer DEFAULT 0 NOT NULL,
	`goals_scored_home` integer DEFAULT 0 NOT NULL,
	`goals_conceded_home` integer DEFAULT 0 NOT NULL,
	`goals_scored_away` integer DEFAULT 0 NOT NULL,
	`goals_conceded_away` integer DEFAULT 0 NOT NULL,
	`attack_strength_home` real DEFAULT 1 NOT NULL,
	`defense_strength_home` real DEFAULT 1 NOT NULL,
	`attack_strength_away` real DEFAULT 1 NOT NULL,
	`defense_strength_away` real DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_team_stats_team_id` ON `team_stats` (`team_id`);--> statement-breakpoint
CREATE TABLE `teams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`league` text DEFAULT 'Premier League' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_teams_name` ON `teams` (`name`);--> statement-breakpoint
CREATE INDEX `idx_teams_league` ON `teams` (`league`);--> statement-breakpoint
CREATE TABLE `user_portfolios` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`current_bankroll` real DEFAULT 1000 NOT NULL,
	`initial_bankroll` real DEFAULT 1000 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
