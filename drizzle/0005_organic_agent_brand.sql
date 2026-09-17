ALTER TABLE `fixtures` ADD `api_football_fixture_id` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_fixtures_api_football_id` ON `fixtures` (`api_football_fixture_id`);