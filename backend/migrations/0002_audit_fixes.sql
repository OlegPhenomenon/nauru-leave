-- B: optimistic concurrency for account administration.
ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
