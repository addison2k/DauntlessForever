CREATE TABLE `invitecodes` (
	`invitecode` text PRIMARY KEY NOT NULL,
	`usesRemaining` integer NOT NULL,
	`infiniteUses` boolean NOT NULL
);
