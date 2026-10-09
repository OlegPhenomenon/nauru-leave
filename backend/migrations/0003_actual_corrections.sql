-- Guided corrections retain their original day/account allocation. Manual
-- adjustments have no rows here and remain independent.
CREATE TABLE actual_correction_allocations (
 adjustment_id INTEGER NOT NULL REFERENCES adjustments(id),
 request_id INTEGER NOT NULL REFERENCES leave_requests(id),
 day_id INTEGER NOT NULL REFERENCES request_days(id),
 date TEXT NOT NULL,
 account_id INTEGER NOT NULL REFERENCES leave_accounts(id),
 minutes INTEGER NOT NULL CHECK(minutes > 0),
 PRIMARY KEY(adjustment_id, day_id, account_id)
);
CREATE INDEX actual_correction_day ON actual_correction_allocations(request_id,date,account_id);
-- Earlier guided corrections already recorded the selected dates and proposal
-- ids in their audit event. Preserve those links across an upgrade.
INSERT INTO actual_correction_allocations
 SELECT a.id,a.request_id,d.id,d.date,a.account_id,SUM(ra.minutes)
 FROM audit_events e
 JOIN json_each(e.details_json,'$.adjustment_ids') ai
 JOIN adjustments a ON a.id=ai.value AND a.request_id=e.entity_id
 JOIN json_each(e.details_json,'$.worked_dates') wd
 JOIN leave_requests lr ON lr.id=a.request_id
 JOIN request_days d ON d.revision_id=lr.effective_revision_id AND d.date=wd.value
 JOIN revision_allocations ra ON ra.day_id=d.id AND ra.account_id=a.account_id
 WHERE e.action='request.propose_actual_adjustment'
 GROUP BY a.id,d.id,a.account_id;
