-- A: versioned conditions, historical reservations and transfer contents.
ALTER TABLE leave_types ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE org_units ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE employees ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE schedules ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE schedule_versions ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE policy_versions ADD COLUMN carryover_limit_min INTEGER CHECK(carryover_limit_min IS NULL OR carryover_limit_min>=0);
ALTER TABLE policy_versions ADD COLUMN paid INTEGER NOT NULL DEFAULT 1;
ALTER TABLE policy_versions ADD COLUMN uses_balance INTEGER NOT NULL DEFAULT 1;
ALTER TABLE policy_versions ADD COLUMN allow_half_day INTEGER NOT NULL DEFAULT 1;
ALTER TABLE policy_versions ADD COLUMN requires_attachment INTEGER NOT NULL DEFAULT 0;
ALTER TABLE policy_versions ADD COLUMN min_notice_days INTEGER NOT NULL DEFAULT 0;
UPDATE policy_versions SET
 paid=(SELECT paid FROM leave_types WHERE id=leave_type_id),
 uses_balance=(SELECT uses_balance FROM leave_types WHERE id=leave_type_id),
 allow_half_day=(SELECT allow_half_day FROM leave_types WHERE id=leave_type_id),
 requires_attachment=(SELECT requires_attachment FROM leave_types WHERE id=leave_type_id),
 min_notice_days=(SELECT min_notice_days FROM leave_types WHERE id=leave_type_id);
ALTER TABLE request_revisions ADD COLUMN policy_version_id INTEGER REFERENCES policy_versions(id);
ALTER TABLE request_revisions ADD COLUMN policy_snapshot TEXT;
-- Legacy submissions did not record business dates or policy provenance. Preserve
-- their saved minutes; recover conditions and the dated policy when available.
UPDATE request_revisions SET policy_version_id=(SELECT id FROM policy_versions p
 WHERE p.leave_type_id=request_revisions.leave_type_id AND p.valid_from<=substr(request_revisions.submitted_at,1,10)
 ORDER BY p.valid_from DESC,p.id DESC LIMIT 1),
 policy_snapshot=(SELECT json_object('paid',json(CASE paid WHEN 1 THEN 'true' ELSE 'false' END),
 'uses_balance',json(CASE uses_balance WHEN 1 THEN 'true' ELSE 'false' END),
 'allow_half_day',json(CASE allow_half_day WHEN 1 THEN 'true' ELSE 'false' END),
 'requires_attachment',json(CASE requires_attachment WHEN 1 THEN 'true' ELSE 'false' END),
 'sensitive',json(CASE sensitive WHEN 1 THEN 'true' ELSE 'false' END),'min_notice_days',min_notice_days)
 FROM leave_types WHERE id=request_revisions.leave_type_id)
 WHERE submitted_at IS NOT NULL;
-- Conditions now live exclusively on the dated policy and submitted snapshot.
ALTER TABLE leave_types DROP COLUMN paid;
ALTER TABLE leave_types DROP COLUMN uses_balance;
ALTER TABLE leave_types DROP COLUMN allow_half_day;
ALTER TABLE leave_types DROP COLUMN requires_attachment;
ALTER TABLE leave_types DROP COLUMN min_notice_days;
ALTER TABLE reservations ADD COLUMN reserved_on TEXT;
ALTER TABLE reservations ADD COLUMN released_on TEXT;
UPDATE reservations SET reserved_on=substr(created_at,1,10),released_on=substr(released_at,1,10);
CREATE INDEX reservations_at_date ON reservations(account_id,reserved_on,released_on);
CREATE TABLE calendar_exceptions_new (
 id INTEGER PRIMARY KEY,date TEXT NOT NULL,name TEXT NOT NULL,minutes INTEGER NOT NULL DEFAULT 0,
 schedule_id INTEGER REFERENCES schedules(id),created_at TEXT NOT NULL,
 revoked_at TEXT,revoked_by INTEGER REFERENCES users(id),reason TEXT
);
INSERT INTO calendar_exceptions_new(id,date,name,minutes,schedule_id,created_at)
 SELECT id,date,name,minutes,schedule_id,created_at FROM calendar_exceptions;
DROP TABLE calendar_exceptions;
ALTER TABLE calendar_exceptions_new RENAME TO calendar_exceptions;
CREATE INDEX calendar_exceptions_live ON calendar_exceptions(date,schedule_id) WHERE revoked_at IS NULL;
ALTER TABLE export_batches ADD COLUMN org_unit_id INTEGER REFERENCES org_units(id);
CREATE TABLE export_scope (
 export_id INTEGER NOT NULL REFERENCES export_batches(id),
 employee_id INTEGER NOT NULL REFERENCES employees(id),
 PRIMARY KEY(export_id,employee_id)
);
CREATE TABLE export_rows (
 export_id INTEGER NOT NULL REFERENCES export_batches(id),
 employee_id INTEGER NOT NULL REFERENCES employees(id),
 request_id INTEGER NOT NULL REFERENCES leave_requests(id),
 revision_id INTEGER NOT NULL REFERENCES request_revisions(id),
 date TEXT NOT NULL,
 minutes INTEGER NOT NULL,
 PRIMARY KEY(export_id,request_id,date)
);
CREATE TABLE period_closures (
 account_id INTEGER PRIMARY KEY REFERENCES leave_accounts(id),
 closed_on TEXT NOT NULL,
 policy_version_id INTEGER NOT NULL REFERENCES policy_versions(id),
 carryover_min INTEGER NOT NULL
);
