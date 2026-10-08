-- Nauru Leave Desk — initial schema (SQLite).
-- All durations are INTEGER minutes. Dates are ISO 'YYYY-MM-DD' TEXT, timestamps ISO-8601 UTC TEXT.
PRAGMA foreign_keys = ON;

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ---------------------------------------------------------------- people & access
CREATE TABLE org_units (
    id        INTEGER PRIMARY KEY,
    code      TEXT NOT NULL UNIQUE,
    name      TEXT NOT NULL,
    parent_id INTEGER REFERENCES org_units(id),
    active    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    display_name  TEXT NOT NULL,
    password_hash TEXT,                 -- argon2id; NULL = cannot log in with password
    totp_secret   TEXT,                 -- base32; required for service roles in production
    active        INTEGER NOT NULL DEFAULT 1,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until  TEXT,
    created_at    TEXT NOT NULL
);

CREATE TABLE sessions (
    token_hash    TEXT PRIMARY KEY,     -- sha256 of cookie token
    user_id       INTEGER NOT NULL REFERENCES users(id),
    csrf_token    TEXT NOT NULL,
    totp_ok       INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    expires_at    TEXT NOT NULL,
    revoked_at    TEXT
);

-- Roles: hr | hr_medical | final_approver | adjustment_approver | tech_admin | auditor
-- Manager authority is NOT a role: it is derived from employment_assignments.
CREATE TABLE role_grants (
    id                 INTEGER PRIMARY KEY,
    user_id            INTEGER NOT NULL REFERENCES users(id),
    role               TEXT NOT NULL CHECK (role IN ('hr','hr_medical','final_approver','adjustment_approver','tech_admin','auditor')),
    scope_org_unit_id  INTEGER REFERENCES org_units(id),   -- NULL = whole service
    valid_from         TEXT NOT NULL,
    valid_to           TEXT,
    granted_by         INTEGER REFERENCES users(id),
    created_at         TEXT NOT NULL
);

CREATE TABLE schedules (
    id   INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
);

CREATE TABLE schedule_versions (
    id          INTEGER PRIMARY KEY,
    schedule_id INTEGER NOT NULL REFERENCES schedules(id),
    valid_from  TEXT NOT NULL,
    valid_to    TEXT,
    mon_min INTEGER NOT NULL, tue_min INTEGER NOT NULL, wed_min INTEGER NOT NULL,
    thu_min INTEGER NOT NULL, fri_min INTEGER NOT NULL, sat_min INTEGER NOT NULL, sun_min INTEGER NOT NULL,
    note        TEXT
);

-- Holidays / special days. schedule_id NULL = applies to every schedule.
CREATE TABLE calendar_exceptions (
    id          INTEGER PRIMARY KEY,
    date        TEXT NOT NULL,
    name        TEXT NOT NULL,
    minutes     INTEGER NOT NULL DEFAULT 0,   -- working minutes on that date (0 = holiday)
    schedule_id INTEGER REFERENCES schedules(id),
    created_at  TEXT NOT NULL,
    UNIQUE (date, schedule_id)
);

CREATE TABLE employees (
    id          INTEGER PRIMARY KEY,
    service_id  TEXT NOT NULL UNIQUE,         -- official staff number; import matches on this, never on name
    full_name   TEXT NOT NULL,
    email       TEXT,
    user_id     INTEGER UNIQUE REFERENCES users(id),   -- optional login
    start_date  TEXT NOT NULL,
    end_date    TEXT,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL
);

-- Transfer history: never overwrite, close valid_to and insert a new row.
CREATE TABLE employment_assignments (
    id                  INTEGER PRIMARY KEY,
    employee_id         INTEGER NOT NULL REFERENCES employees(id),
    org_unit_id         INTEGER NOT NULL REFERENCES org_units(id),
    manager_employee_id INTEGER REFERENCES employees(id),
    valid_from          TEXT NOT NULL,
    valid_to            TEXT
);

CREATE TABLE employee_schedules (
    id          INTEGER PRIMARY KEY,
    employee_id INTEGER NOT NULL REFERENCES employees(id),
    schedule_id INTEGER NOT NULL REFERENCES schedules(id),
    valid_from  TEXT NOT NULL,
    valid_to    TEXT
);

-- Acting-for: to_user may perform from_user's approval steps within [valid_from, valid_to].
CREATE TABLE delegations (
    id          INTEGER PRIMARY KEY,
    from_user_id INTEGER NOT NULL REFERENCES users(id),
    to_user_id   INTEGER NOT NULL REFERENCES users(id),
    scope        TEXT NOT NULL CHECK (scope IN ('manager_recommendation','hr_check','final_decision','all_approvals')),
    valid_from   TEXT NOT NULL,
    valid_to     TEXT NOT NULL,
    reason       TEXT NOT NULL,
    revoked_at   TEXT,
    created_by   INTEGER NOT NULL REFERENCES users(id),
    created_at   TEXT NOT NULL
);

-- ---------------------------------------------------------------- leave rules
CREATE TABLE leave_types (
    id                  INTEGER PRIMARY KEY,
    code                TEXT NOT NULL UNIQUE,
    name                TEXT NOT NULL,
    sensitive           INTEGER NOT NULL DEFAULT 0,   -- medical etc: hidden from team calendar & emails
    paid                INTEGER NOT NULL DEFAULT 1,   -- for reports only
    uses_balance        INTEGER NOT NULL DEFAULT 1,   -- 0 = recorded absence without ledger (e.g. unpaid)
    allow_half_day      INTEGER NOT NULL DEFAULT 1,
    requires_attachment INTEGER NOT NULL DEFAULT 0,
    min_notice_days     INTEGER NOT NULL DEFAULT 0,   -- warning only, never auto-reject
    active              INTEGER NOT NULL DEFAULT 1
);

-- Every rule change = new version with effective date and explanation.
CREATE TABLE policy_versions (
    id                       INTEGER PRIMARY KEY,
    leave_type_id            INTEGER NOT NULL REFERENCES leave_types(id),
    valid_from               TEXT NOT NULL,
    annual_entitlement_min   INTEGER NOT NULL DEFAULT 0,
    accrual_mode             TEXT NOT NULL CHECK (accrual_mode IN ('none','annual_upfront','monthly')),
    advance_publish_months   INTEGER NOT NULL DEFAULT 0,  -- annual_upfront: run for year Y allowed this many months before Jan 1 of Y
    carryover_allowed        INTEGER NOT NULL DEFAULT 0,
    carryover_expiry_months  INTEGER,                      -- NULL = never expires
    allow_negative           INTEGER NOT NULL DEFAULT 0,   -- 1 only with authority + reason
    explanation              TEXT NOT NULL,
    status                   TEXT NOT NULL CHECK (status IN ('demo_fictional','unverified','verified')),
    verified_by              INTEGER REFERENCES users(id),
    created_by               INTEGER REFERENCES users(id),
    created_at               TEXT NOT NULL
);

-- ---------------------------------------------------------------- ledger
CREATE TABLE leave_accounts (
    id            INTEGER PRIMARY KEY,
    employee_id   INTEGER NOT NULL REFERENCES employees(id),
    leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
    period_year   INTEGER NOT NULL,
    UNIQUE (employee_id, leave_type_id, period_year)
);

-- Immutable movements. Balance = SUM(minutes) WHERE effective_date <= :date.
-- kind: opening | accrual | consumption | return | adjustment | carryover_expiry | historical
CREATE TABLE ledger_entries (
    id                INTEGER PRIMARY KEY,
    account_id        INTEGER NOT NULL REFERENCES leave_accounts(id),
    minutes           INTEGER NOT NULL,
    kind              TEXT NOT NULL CHECK (kind IN ('opening','accrual','consumption','return','adjustment','carryover_expiry','historical')),
    effective_date    TEXT NOT NULL,
    request_id        INTEGER REFERENCES leave_requests(id),
    revision_id       INTEGER REFERENCES request_revisions(id),
    reverses_entry_id INTEGER REFERENCES ledger_entries(id),
    adjustment_id     INTEGER REFERENCES adjustments(id),
    import_batch_id   INTEGER REFERENCES import_batches(id),
    basis             TEXT NOT NULL,              -- human explanation shown in "How calculated"
    author_user_id    INTEGER REFERENCES users(id),
    op_key            TEXT NOT NULL UNIQUE,       -- idempotency: replay never posts twice
    created_at        TEXT NOT NULL
);
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;

-- Two-person rule: proposed by one HR officer, applied by a different adjustment_approver.
CREATE TABLE adjustments (
    id             INTEGER PRIMARY KEY,
    account_id     INTEGER NOT NULL REFERENCES leave_accounts(id),
    minutes        INTEGER NOT NULL,
    reason         TEXT NOT NULL,
    basis_document TEXT NOT NULL,
    request_id     INTEGER REFERENCES leave_requests(id),   -- e.g. actual-period correction
    status         TEXT NOT NULL CHECK (status IN ('proposed','applied','rejected')),
    proposed_by    INTEGER NOT NULL REFERENCES users(id),
    proposed_at    TEXT NOT NULL,
    decided_by     INTEGER REFERENCES users(id),
    decided_at     TEXT,
    decision_note  TEXT
);

-- ---------------------------------------------------------------- requests
-- kind: leave | amendment | cancellation. amendment/cancellation have parent_request_id = approved leave request.
-- status: draft | submitted | needs_information | under_review | approved | rejected | withdrawn | cancelled
CREATE TABLE leave_requests (
    id                    INTEGER PRIMARY KEY,
    number                TEXT NOT NULL UNIQUE,     -- e.g. NLD-2026-00017
    employee_id           INTEGER NOT NULL REFERENCES employees(id),
    kind                  TEXT NOT NULL CHECK (kind IN ('leave','amendment','cancellation')),
    parent_request_id     INTEGER REFERENCES leave_requests(id),
    previous_request_id   INTEGER REFERENCES leave_requests(id),  -- "new request linked to rejected/withdrawn one"
    status                TEXT NOT NULL,
    current_revision_id   INTEGER REFERENCES request_revisions(id),  -- latest revision (draft or submitted)
    effective_revision_id INTEGER REFERENCES request_revisions(id),  -- leave only: revision whose days are approved & in force
    source                TEXT NOT NULL CHECK (source IN ('self','paper')),
    paper_received_date   TEXT,
    entered_by_user_id    INTEGER NOT NULL REFERENCES users(id),
    actual_confirmed_by   INTEGER REFERENCES users(id),
    actual_confirmed_at   TEXT,
    actual_note           TEXT,
    version               INTEGER NOT NULL DEFAULT 1,   -- optimistic concurrency token, bumped on every change
    created_at            TEXT NOT NULL,
    updated_at            TEXT NOT NULL
);
CREATE INDEX leave_requests_employee ON leave_requests(employee_id, status);
-- At most one open amendment/cancellation per approved request.
CREATE UNIQUE INDEX one_open_change_per_request ON leave_requests(parent_request_id)
    WHERE parent_request_id IS NOT NULL AND status IN ('draft','submitted','needs_information','under_review');

-- A revision is immutable once submitted_at is set.
CREATE TABLE request_revisions (
    id            INTEGER PRIMARY KEY,
    request_id    INTEGER NOT NULL REFERENCES leave_requests(id),
    rev_no        INTEGER NOT NULL,
    leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
    start_date    TEXT NOT NULL,
    end_date      TEXT NOT NULL,
    start_part    TEXT NOT NULL DEFAULT 'full' CHECK (start_part IN ('full','am','pm')),
    end_part      TEXT NOT NULL DEFAULT 'full' CHECK (end_part IN ('full','am','pm')),
    note          TEXT,
    change_reason TEXT,
    total_minutes INTEGER NOT NULL,
    created_by    INTEGER NOT NULL REFERENCES users(id),
    created_at    TEXT NOT NULL,
    submitted_at  TEXT,
    UNIQUE (request_id, rev_no)
);

-- Per-date breakdown frozen at submission (schedule + exception snapshot).
-- An approved cancellation creates its OWN revision on the cancellation
-- request: days inside the cancelled range get part='none', minutes=0 and an
-- explanation "Cancelled by <number>". Submitted revisions are never mutated.
CREATE TABLE request_days (
    id                  INTEGER PRIMARY KEY,
    revision_id         INTEGER NOT NULL REFERENCES request_revisions(id),
    date                TEXT NOT NULL,
    part                TEXT NOT NULL CHECK (part IN ('full','am','pm','none')),  -- none = non-working/cancelled day inside range
    scheduled_minutes   INTEGER NOT NULL,
    minutes             INTEGER NOT NULL,
    schedule_version_id INTEGER REFERENCES schedule_versions(id),
    exception_id        INTEGER REFERENCES calendar_exceptions(id),
    period_year         INTEGER NOT NULL,
    explanation         TEXT NOT NULL,
    UNIQUE (revision_id, date)
);

-- Which account pays for which minutes of a revision (a day may split across accounts via carryover).
CREATE TABLE revision_allocations (
    id          INTEGER PRIMARY KEY,
    revision_id INTEGER NOT NULL REFERENCES request_revisions(id),
    day_id      INTEGER NOT NULL REFERENCES request_days(id),
    account_id  INTEGER NOT NULL REFERENCES leave_accounts(id),
    minutes     INTEGER NOT NULL
);

CREATE TABLE reservations (
    id             INTEGER PRIMARY KEY,
    request_id     INTEGER NOT NULL REFERENCES leave_requests(id),
    revision_id    INTEGER NOT NULL REFERENCES request_revisions(id),
    account_id     INTEGER NOT NULL REFERENCES leave_accounts(id),
    minutes        INTEGER NOT NULL CHECK (minutes > 0),
    active         INTEGER NOT NULL DEFAULT 1,
    created_at     TEXT NOT NULL,
    released_at    TEXT,
    release_reason TEXT          -- approved | rejected | withdrawn | superseded | cancelled
);
CREATE INDEX reservations_active ON reservations(account_id) WHERE active = 1;

-- step kind: manager_recommendation | hr_check | final_decision
-- status: waiting (earlier step open) | pending (actionable) | done | superseded (revision replaced) | skipped_by_rejection
CREATE TABLE approval_steps (
    id                INTEGER PRIMARY KEY,
    request_id        INTEGER NOT NULL REFERENCES leave_requests(id),
    revision_id       INTEGER NOT NULL REFERENCES request_revisions(id),
    seq               INTEGER NOT NULL,
    kind              TEXT NOT NULL CHECK (kind IN ('manager_recommendation','hr_check','final_decision')),
    assignee_user_id  INTEGER REFERENCES users(id),  -- NULL = unassigned → shown to HR as a problem
    status            TEXT NOT NULL CHECK (status IN ('waiting','pending','done','superseded','closed')),
    outcome           TEXT,
    created_at        TEXT NOT NULL,
    completed_at      TEXT
);

-- outcome: recommend_approve | recommend_reject | checked_ok | checked_problem | approve | reject | needs_information
CREATE TABLE decisions (
    id                  INTEGER PRIMARY KEY,
    request_id          INTEGER NOT NULL REFERENCES leave_requests(id),
    revision_id         INTEGER NOT NULL REFERENCES request_revisions(id),
    step_id             INTEGER NOT NULL REFERENCES approval_steps(id),
    actor_user_id       INTEGER NOT NULL REFERENCES users(id),
    acting_for_user_id  INTEGER REFERENCES users(id),     -- set when acting via delegation
    authority           TEXT NOT NULL,                    -- e.g. 'manager of IU', 'hr scope: all', 'final_approver', 'delegation #3'
    outcome             TEXT NOT NULL,
    reason              TEXT,
    basis_document      TEXT,
    created_at          TEXT NOT NULL
);
CREATE TRIGGER decisions_no_update BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;
CREATE TRIGGER decisions_no_delete BEFORE DELETE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions are immutable'); END;

-- kind: comment | question (needs_information) | answer | system
CREATE TABLE messages (
    id             INTEGER PRIMARY KEY,
    request_id     INTEGER NOT NULL REFERENCES leave_requests(id),
    author_user_id INTEGER REFERENCES users(id),
    kind           TEXT NOT NULL CHECK (kind IN ('comment','question','answer','system')),
    body           TEXT NOT NULL,
    created_at     TEXT NOT NULL
);

CREATE TABLE attachments (
    id           INTEGER PRIMARY KEY,
    request_id   INTEGER NOT NULL REFERENCES leave_requests(id),
    uploaded_by  INTEGER NOT NULL REFERENCES users(id),
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,       -- detected from magic bytes, not trusted from client
    size_bytes   INTEGER NOT NULL,
    sha256       TEXT NOT NULL,
    storage_key  TEXT NOT NULL UNIQUE,
    sensitivity  TEXT NOT NULL CHECK (sensitivity IN ('normal','medical')),
    scan_status  TEXT NOT NULL CHECK (scan_status IN ('pending','clean','quarantined','scan_failed')),
    scan_note    TEXT,
    created_at   TEXT NOT NULL
);

-- ---------------------------------------------------------------- import / export / ops
CREATE TABLE import_batches (
    id           INTEGER PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('employees','opening_balances','historical_leave')),
    mode         TEXT,                 -- historical_leave: 'already_in_opening' | 'post_movements'
    filename     TEXT NOT NULL,
    sha256       TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('previewed','committed','discarded')),
    rows_total   INTEGER NOT NULL,
    rows_valid   INTEGER NOT NULL,
    preview_json TEXT NOT NULL,        -- parsed rows + per-row errors
    created_by   INTEGER NOT NULL REFERENCES users(id),
    created_at   TEXT NOT NULL,
    committed_at TEXT
);
CREATE UNIQUE INDEX import_once ON import_batches(kind, sha256) WHERE status = 'committed';

CREATE TABLE export_batches (
    id             INTEGER PRIMARY KEY,
    kind           TEXT NOT NULL,      -- 'approved_leave_transfer' | report names
    period_from    TEXT,
    period_to      TEXT,
    row_count      INTEGER NOT NULL,
    sha256         TEXT NOT NULL,
    content        BLOB NOT NULL,
    created_by     INTEGER NOT NULL REFERENCES users(id),
    created_at     TEXT NOT NULL,
    transferred_by INTEGER REFERENCES users(id),
    transferred_at TEXT,
    accepted_note  TEXT
);

-- dedupe_key makes enqueue idempotent; worker retries with backoff; outcome independent of the business action.
CREATE TABLE notifications (
    id              INTEGER PRIMARY KEY,
    recipient_user_id INTEGER REFERENCES users(id),
    to_email        TEXT NOT NULL,
    subject         TEXT NOT NULL,       -- minimal data, never medical details
    body            TEXT NOT NULL,
    link_path       TEXT NOT NULL,       -- page behind login
    status          TEXT NOT NULL CHECK (status IN ('queued','sent','failed','gave_up')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    next_attempt_at TEXT NOT NULL,
    dedupe_key      TEXT NOT NULL UNIQUE,
    created_at      TEXT NOT NULL,
    sent_at         TEXT
);

-- Demo-only local mail viewer target. Production would use SMTP instead.
CREATE TABLE mailbox (
    id              INTEGER PRIMARY KEY,
    notification_id INTEGER NOT NULL UNIQUE REFERENCES notifications(id),
    to_email        TEXT NOT NULL,
    subject         TEXT NOT NULL,
    body            TEXT NOT NULL,
    delivered_at    TEXT NOT NULL
);

CREATE TABLE idempotency_keys (
    key           TEXT NOT NULL,
    user_id       INTEGER NOT NULL,
    request_hash  TEXT NOT NULL,       -- sha256(method+path+body); same key + different body → 422
    response_json TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
);

CREATE TABLE audit_events (
    id                 INTEGER PRIMARY KEY,
    at                 TEXT NOT NULL,
    actor_user_id      INTEGER REFERENCES users(id),
    acting_for_user_id INTEGER REFERENCES users(id),
    action             TEXT NOT NULL,     -- e.g. request.submit, step.decide, ledger.post, attachment.download
    entity             TEXT NOT NULL,
    entity_id          INTEGER,
    details_json       TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_entity ON audit_events(entity, entity_id);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
