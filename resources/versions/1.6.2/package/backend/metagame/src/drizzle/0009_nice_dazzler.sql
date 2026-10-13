PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`userId` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`notes` integer NOT NULL,
	`isAdmin` boolean DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_users`("userId", "name", "notes", "isAdmin") SELECT "userId", "name", "notes", "isAdmin" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;