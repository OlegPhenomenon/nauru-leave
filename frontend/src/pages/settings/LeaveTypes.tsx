import { useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { newIdempotencyKey, post, put, type ApiError } from '../../api/client';
import type { LeaveType, PolicyVersion } from '../../api/types';
import {
  Details,
  EmptyState,
  ErrBox,
  Field,
  Loading,
  Menu,
  Modal,
  PageHeader,
  PolicyBadge,
  Tag,
} from '../../components/ui';
import { fmtDate, fmtDuration, plural } from '../../lib/format';
import { daysToMinutes, minutesToDays, STANDARD_DAY_MINUTES } from '../../lib/domain';
import { useSession } from '../../lib/session';
import { useApi } from '../../lib/useApi';
import { readAll } from './data';
import { AffectedRequests, type AffectedRequest, Check, SidePanel, useSave } from './shared';

/* ------------------------------------------------------------------ */
/* Rules → sentences                                                   */
/* ------------------------------------------------------------------ */

function daysAYear(pv: PolicyVersion): string {
  return fmtDuration(pv.annual_entitlement_min, STANDARD_DAY_MINUTES);
}

/** Short clause used in the table and in "From <date>:" lines. */
function rulesSummary(pv: PolicyVersion): string {
  if (!pv.uses_balance) return 'no yearly allowance';
  return `${daysAYear(pv)} a year`;
}

/** One fact per line, in plain English, for the rule panel. */
function policyLines(pv: PolicyVersion): string[] {
  const lines: string[] = [];
  if (!pv.uses_balance) {
    lines.push('Not counted against a yearly allowance.');
  } else {
    const how =
      pv.accrual_mode === 'annual_upfront'
        ? ', added on 1 January'
        : pv.accrual_mode === 'monthly'
          ? ', added month by month'
          : '';
    lines.push(pv.accrual_mode === 'none' ? 'Days are added by HR when needed.' : `${daysAYear(pv)} a year${how}.`);
  }
  lines.push(pv.paid ? 'Paid.' : 'Unpaid.');
  lines.push(pv.allow_half_day ? 'Half days allowed.' : 'Whole days only.');
  lines.push(
    pv.min_notice_days > 0
      ? `${plural(pv.min_notice_days, 'day')} of notice needed.`
      : 'No minimum notice.',
  );
  if (pv.requires_attachment) lines.push('A document must be attached.');
  if (pv.uses_balance) {
    if (pv.carryover_allowed) {
      const limit =
        pv.carryover_limit_min != null
          ? `Up to ${fmtDuration(pv.carryover_limit_min, STANDARD_DAY_MINUTES)} carry over`
          : 'Days carry over';
      const expiry =
        pv.carryover_expiry_months == null
          ? "they don't expire"
          : pv.carryover_expiry_months === 0
            ? 'they expire at the start of the next year'
            : `they expire after ${plural(pv.carryover_expiry_months, 'month')}`;
      lines.push(`${limit}; ${expiry}.`);
    } else {
      lines.push('Nothing carries over to the next year.');
    }
    if (pv.allow_negative) lines.push('The balance may go below zero.');
    if (pv.advance_publish_months > 0) {
      lines.push(`Next year's days appear ${plural(pv.advance_publish_months, 'month')} early.`);
    }
  }
  return lines;
}

function allVersions(t: LeaveType): PolicyVersion[] {
  const list = t.policies?.length ? t.policies : t.policy ? [t.policy] : [];
  return [...list].sort((a, b) => a.valid_from.localeCompare(b.valid_from));
}

/** The version whose rules the panel treats as "current". */
function currentVersion(t: LeaveType): PolicyVersion | null {
  return t.policy;
}

function upcomingVersions(t: LeaveType, today: string): PolicyVersion[] {
  return allVersions(t).filter((p) => p.valid_from > today);
}

/* ------------------------------------------------------------------ */
/* Form state shared by the add and change-rules dialogs               */
/* ------------------------------------------------------------------ */

interface RuleForm {
  valid_from: string;
  uses_balance: boolean;
  days_per_year: number;
  accrual_mode: string; // 'annual_upfront' | 'monthly' | 'none'
  advance_publish_months: number;
  paid: boolean;
  allow_half_day: boolean;
  requires_attachment: boolean;
  min_notice_days: number;
  carryover_allowed: boolean;
  carryover_limit: 'none' | 'days';
  carryover_limit_days: number;
  carryover_expiry: 'never' | 'months';
  carryover_expiry_months: number;
  allow_negative: boolean;
  explanation: string;
}

function defaultsFromPolicy(pv: PolicyVersion | null, validFrom: string): RuleForm {
  return {
    valid_from: validFrom,
    uses_balance: pv?.uses_balance ?? true,
    days_per_year: minutesToDays(pv?.annual_entitlement_min ?? null, STANDARD_DAY_MINUTES) ?? 20,
    accrual_mode: pv?.accrual_mode ?? 'annual_upfront',
    advance_publish_months: pv?.advance_publish_months ?? 0,
    paid: pv?.paid ?? true,
    allow_half_day: pv?.allow_half_day ?? true,
    requires_attachment: pv?.requires_attachment ?? false,
    min_notice_days: pv?.min_notice_days ?? 0,
    carryover_allowed: pv?.carryover_allowed ?? false,
    carryover_limit: pv?.carryover_limit_min == null ? 'none' : 'days',
    carryover_limit_days:
      minutesToDays(pv?.carryover_limit_min ?? null, STANDARD_DAY_MINUTES) ?? 10,
    carryover_expiry: pv?.carryover_expiry_months == null ? 'never' : 'months',
    carryover_expiry_months: pv?.carryover_expiry_months ?? 0,
    allow_negative: pv?.allow_negative ?? false,
    explanation: pv?.status === 'demo_fictional' ? '' : pv?.explanation ?? '',
  };
}

function autoExplanation(f: RuleForm): string {
  const bits: string[] = [];
  bits.push(
    f.uses_balance && f.accrual_mode !== 'none'
      ? `${f.days_per_year} days a year`
      : 'not counted against a yearly allowance',
  );
  bits.push(f.paid ? 'paid' : 'unpaid');
  bits.push(f.allow_half_day ? 'half days allowed' : 'whole days only');
  if (f.min_notice_days > 0) bits.push(`${f.min_notice_days} days of notice`);
  if (f.requires_attachment) bits.push('document required');
  if (f.carryover_allowed) {
    bits.push(
      f.carryover_limit === 'days'
        ? `carry-over up to ${f.carryover_limit_days} days`
        : 'carry-over allowed',
    );
  }
  return bits.join('; ');
}

function policyBody(f: RuleForm) {
  const usesBalance = f.uses_balance;
  return {
    valid_from: f.valid_from,
    annual_entitlement_min: usesBalance
      ? daysToMinutes(f.days_per_year, STANDARD_DAY_MINUTES)
      : 0,
    accrual_mode: usesBalance ? f.accrual_mode : 'none',
    advance_publish_months: usesBalance ? f.advance_publish_months : 0,
    carryover_allowed: usesBalance ? f.carryover_allowed : false,
    carryover_expiry_months:
      usesBalance && f.carryover_allowed && f.carryover_expiry === 'months' ? f.carryover_expiry_months : null,
    carryover_limit_min:
      usesBalance && f.carryover_allowed && f.carryover_limit === 'days'
        ? daysToMinutes(f.carryover_limit_days, STANDARD_DAY_MINUTES)
        : null,
    paid: f.paid,
    uses_balance: usesBalance,
    allow_half_day: f.allow_half_day,
    requires_attachment: f.requires_attachment,
    min_notice_days: f.min_notice_days,
    allow_negative: usesBalance ? f.allow_negative : false,
    explanation: f.explanation.trim() || autoExplanation(f),
  };
}

/** The full rule form, with the rarely changed parts behind "More rules". */
function RuleFields({ f, setF }: { f: RuleForm; setF: (f: RuleForm) => void }) {
  return (
    <>
      <Check
        label="Counts against a yearly allowance"
        checked={f.uses_balance}
        onChange={(v) => setF({ ...f, uses_balance: v })}
      />
      {f.uses_balance ? (
        <Field label="Days per year">
          <input
            type="number"
            min={0}
            step={0.5}
            value={f.days_per_year}
            onChange={(e) => setF({ ...f, days_per_year: Number(e.target.value) })}
          />
        </Field>
      ) : null}
      <Check label="Paid" checked={f.paid} onChange={(v) => setF({ ...f, paid: v })} />
      <Check
        label="Half days allowed"
        checked={f.allow_half_day}
        onChange={(v) => setF({ ...f, allow_half_day: v })}
      />
      <Field label="Minimum notice (days)">
        <input
          type="number"
          min={0}
          value={f.min_notice_days}
          onChange={(e) => setF({ ...f, min_notice_days: Number(e.target.value) })}
        />
      </Field>
      <Check
        label="Needs a document"
        hint="The request can't be sent without a file attached."
        checked={f.requires_attachment}
        onChange={(v) => setF({ ...f, requires_attachment: v })}
      />
      <Details title="More rules">
        {f.uses_balance ? (
          <>
            <Field label="How the days are added">
              <select
                value={f.accrual_mode}
                onChange={(e) => setF({ ...f, accrual_mode: e.target.value })}
              >
                <option value="annual_upfront">All at once each year</option>
                <option value="monthly">Each month</option>
                <option value="none">Not added automatically</option>
              </select>
            </Field>
            <Field
              label="Make next year's days available early (months)"
              hint="0 = they appear on 1 January."
            >
              <input
                type="number"
                min={0}
                max={12}
                value={f.advance_publish_months}
                onChange={(e) =>
                  setF({ ...f, advance_publish_months: Number(e.target.value) })
                }
              />
            </Field>
            <Check
              label="Days carry over to the next year"
              checked={f.carryover_allowed}
              onChange={(v) => setF({ ...f, carryover_allowed: v })}
            />
            {f.carryover_allowed ? (
              <>
                <Field label="Carry-over limit">
                  <select value={f.carryover_limit} onChange={(e) => setF({ ...f, carryover_limit: e.target.value as 'none' | 'days' })}>
                    <option value="none">No limit</option><option value="days">Limit in days</option>
                  </select>
                </Field>
                {f.carryover_limit === 'days' ? <Field label="Maximum days carried over"><input type="number" min={0} step={0.5} value={f.carryover_limit_days} onChange={(e) => setF({ ...f, carryover_limit_days: Number(e.target.value) })} /></Field> : null}
                <Field label="Carried-over days expire">
                  <select value={f.carryover_expiry} onChange={(e) => setF({ ...f, carryover_expiry: e.target.value as 'never' | 'months' })}>
                    <option value="never">Never</option><option value="months">After a number of months</option>
                  </select>
                </Field>
                {f.carryover_expiry === 'months' ? <Field label="Months until expiry" hint="0 means the start of the next year."><input type="number" min={0} step={1} value={f.carryover_expiry_months} onChange={(e) => setF({ ...f, carryover_expiry_months: Number(e.target.value) })} /></Field> : null}
              </>
            ) : null}
                <Check
                  label="The balance may go below zero"
                  checked={f.allow_negative}
                  onChange={(v) => setF({ ...f, allow_negative: v })}
                />
          </>
        ) : null}
        <Field
          label="Rule explanation"
          hint="Shown to HR next to the rules. Filled in from the choices above — edit if needed."
        >
          <textarea
            value={f.explanation}
            onChange={(e) => setF({ ...f, explanation: e.target.value })}
            onFocus={(e) => {
              if (!e.target.value) setF({ ...f, explanation: autoExplanation(f) });
            }}
            onBlur={(e) => {
              if (!e.target.value.trim()) setF({ ...f, explanation: autoExplanation(f) });
            }}
          />
        </Field>
      </Details>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Section                                                             */
/* ------------------------------------------------------------------ */

export default function LeaveTypes() {
  const { me, config } = useSession();
  const canEdit = me?.roles.some((r) => r.role === 'hr' && r.scope_org_unit_id === null) ?? false;
  const q = useApi(() => readAll<LeaveType>('/leave-types'), []);
  const [affected, setAffected] = useState<AffectedRequest[]>([]);
  const [params, setParams] = useSearchParams();
  const [addOpen, setAddOpen] = useState(false);
  const [changeFor, setChangeFor] = useState<LeaveType | null>(null);
  const [renameFor, setRenameFor] = useState<LeaveType | null>(null);
  const { err, busy, run } = useSave();

  const selId = Number(params.get('type')) || null;
  const sel = useMemo(
    () => q.data?.find((t) => t.id === selId) ?? null,
    [q.data, selId],
  );

  const openPanel = (id: number) => {
    const next = new URLSearchParams(params);
    next.set('type', String(id));
    setParams(next);
  };
  const closePanel = () => {
    const next = new URLSearchParams(params);
    next.delete('type');
    setParams(next);
  };

  if (q.loading) return <Loading />;
  if (q.error) return <ErrBox error={q.error} />;

  const types = [...(q.data ?? [])].sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <>
      <PageHeader
        title="Leave types"
        subtitle="What people can book, and the rules behind each type."
        primary={
          canEdit ? (
            <button type="button" className="btn" onClick={() => setAddOpen(true)}>
              Add leave type
            </button>
          ) : undefined
        }
      />
      <AffectedRequests requests={affected} />
      {types.length === 0 ? (
        <EmptyState
          text="No leave types yet."

        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Paid</th>
                <th>Days a year</th>
                <th>Half days</th>
                <th>Notice</th>
                <th>Status</th>
                {canEdit ? <th>Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {types.map((t) => {
                const pv = t.policy;
                const upcoming = upcomingVersions(t, config?.business_date ?? '');
                return (
                  <tr key={t.id} className="row-link" onClick={() => openPanel(t.id)}>
                    <td>
                      <Link onClick={(e) => e.stopPropagation()} to={`/settings/leave-types?type=${t.id}`}>{t.name}</Link>{' '}
                      {t.sensitive ? <Tag>Sensitive</Tag> : null}
                    </td>
                    <td>{pv ? (pv.paid ? 'Paid' : 'Unpaid') : '—'}</td>
                    <td>{pv?.uses_balance ? daysAYear(pv) : '—'}</td>
                    <td>{pv ? (pv.allow_half_day ? 'Yes' : 'Whole days only') : '—'}</td>
                    <td>
                      {pv
                        ? pv.min_notice_days > 0
                          ? plural(pv.min_notice_days, 'day')
                          : 'None'
                        : '—'}
                    </td>
                    <td>
                      {!t.active ? (
                        <Tag>Inactive</Tag>
                      ) : !pv ? (
                        <Tag tone="warn">No rules yet</Tag>
                      ) : upcoming.length ? (
                        <Tag tone="warn">Changes on {fmtDate(upcoming[0]!.valid_from)}</Tag>
                      ) : <Tag>Active</Tag>}
                    </td>
                    {canEdit ? <td><button type="button" className="btn btn-secondary btn-sm" onClick={(e) => { e.stopPropagation(); setChangeFor(t); }}>Change rules</button></td> : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {sel ? (
        <TypePanel
          t={sel}
          businessDate={config?.business_date ?? ''}
          canEdit={canEdit}
          busy={busy}
          err={err}
          onClose={closePanel}
          onChangeRules={() => setChangeFor(sel)}
          onRename={() => setRenameFor(sel)}
          onToggleActive={() =>
            void run(async () => {
              await put(`/leave-types/${sel.id}`, {
                code: sel.code,
                name: sel.name,
                sensitive: sel.sensitive,
                active: !sel.active,
                expected_version: sel.version,
              });
              q.reload();
              return sel.active
                ? `${sel.name} is no longer offered.`
                : `${sel.name} is offered again.`;
            })
          }
          onVerify={(pv) =>
            void run(async () => {
              await post(`/policies/${pv.id}/verify`);
              q.reload();
              return 'Rules marked as checked.';
            })
          }
        />
      ) : null}

      {addOpen && config ? (
        <AddTypeModal
          businessDate={config.business_date}
          existingCodes={types.map((t) => t.code)}
          onClose={() => { setAddOpen(false); q.reload(); }}
          onDone={() => {
            setAddOpen(false);
            q.reload();
          }}
        />
      ) : null}

      {changeFor && config ? (
        <ChangeRulesModal
          t={changeFor}
          businessDate={config.business_date}
          onClose={() => setChangeFor(null)}
          onDone={(affected) => {
            setChangeFor(null);
            q.reload();
            setAffected(affected);
          }}
        />
      ) : null}

      {renameFor ? (
        <RenameModal
          t={renameFor}
          onClose={() => setRenameFor(null)}
          onDone={() => {
            setRenameFor(null);
            q.reload();
          }}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Side panel                                                          */
/* ------------------------------------------------------------------ */

function TypePanel({
  t,
  businessDate,
  canEdit,
  busy,
  err,
  onClose,
  onChangeRules,
  onRename,
  onToggleActive,
  onVerify,
}: {
  t: LeaveType;
  businessDate: string;
  canEdit: boolean;
  busy: boolean;
  err: ApiError | null;
  onClose: () => void;
  onChangeRules: () => void;
  onRename: () => void;
  onToggleActive: () => void;
  onVerify: (pv: PolicyVersion) => void;
}) {
  const cur = currentVersion(t);
  const upcoming = upcomingVersions(t, businessDate);
  const versions = allVersions(t);
  const verifiable = cur && cur.status !== 'verified' && cur.status !== 'demo_fictional';
  const more = [
    { label: 'Rename…', onSelect: onRename },
    verifiable
      ? { label: 'Mark rules as checked', onSelect: () => onVerify(cur!) }
      : null,
    t.active
      ? { label: 'Make inactive', onSelect: onToggleActive, danger: true }
      : { label: 'Make active again', onSelect: onToggleActive },
  ].filter((x): x is NonNullable<typeof x> => x !== null);

  return (
    <SidePanel title={t.name} onClose={onClose}>
      <p>
        {t.sensitive ? <Tag>Sensitive</Tag> : null}{' '}
        {!t.active ? <Tag>Inactive</Tag> : null} <PolicyBadge policy={cur} />
      </p>
      {cur ? (
        <ul className="sentence-list">
          {policyLines(cur).map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">No rules yet — add them with “Change rules from a date…”.</p>
      )}
      {upcoming.map((pv) => (
        <p key={pv.id} className="small">
          <strong>From {fmtDate(pv.valid_from)}:</strong> {rulesSummary(pv)}.
        </p>
      ))}
      {cur?.explanation && cur.status !== 'demo_fictional' ? <p className="muted small">{cur.explanation}</p> : null}
      {err ? <ErrBox error={err} /> : null}
      {canEdit ? (
        <div className="btn-row">
          <button type="button" className="btn btn-secondary" onClick={onChangeRules} disabled={busy}>
            Change rules from a date…
          </button>
          <Menu label="More" items={more} align="start" />
        </div>
      ) : null}
      {versions.length ? (
        <Details title="Rule history" count={versions.length}>
          <ul className="sentence-list">
            {[...versions].reverse().map((pv) => (
              <li key={pv.id}>
                <span>
                  From {fmtDate(pv.valid_from)} — {rulesSummary(pv)}
                  {pv.in_force ? ' (in force now)' : ''}
                </span>
                <Details title="Rules on this date"><ul className="sentence-list">{policyLines(pv).map((line) => <li key={line}>{line}</li>)}</ul>{pv.explanation && pv.status !== 'demo_fictional' ? <p className="muted small">{pv.explanation}</p> : null}{canEdit && pv.status !== 'verified' && pv.status !== 'demo_fictional' ? <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onVerify(pv)}>Mark rules as checked</button> : null}</Details>
              </li>
            ))}
          </ul>
        </Details>
      ) : null}
    </SidePanel>
  );
}

/* ------------------------------------------------------------------ */
/* Add leave type (type + first rule in one dialog)                    */
/* ------------------------------------------------------------------ */

export function AddTypeModal({
  businessDate,
  existingCodes,
  onClose,
  onDone,
}: {
  businessDate: string;
  existingCodes: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { err, busy, run } = useSave();
  const [createdId, setCreatedId] = useState<number | null>(null);
  const [createKey] = useState(newIdempotencyKey);
  const [ruleKey] = useState(newIdempotencyKey);
  const [name, setName] = useState('');
  const [sensitive, setSensitive] = useState(false);
  const [f, setF] = useState<RuleForm>(() => defaultsFromPolicy(null, businessDate));

  const baseCode =
    name
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'TYPE';
  let code = baseCode;
  for (let n = 2; existingCodes.includes(code); n++) code = `${baseCode}_${n}`;

  return (
    <Modal title="Add leave type" onClose={onClose} wide footer={<> <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !name.trim() || !f.valid_from}
          onClick={() =>
            void run(async () => {
              let id = createdId;
              if (id === null) {
                const created = await post<{ id: number }>('/leave-types', { code, name: name.trim(), sensitive, active: true }, createKey);
                id = created.id;
                setCreatedId(id);
              }
              await post(`/leave-types/${id}/policies`, policyBody(f), ruleKey);
              onDone();
              return `${name.trim()} added.`;
            })
          }
        >
          {busy ? 'Saving…' : createdId ? 'Save rules' : 'Add leave type'}
        </button>

       </>}>
      {err ? <ErrBox error={err} /> : null}
      {createdId ? <p className="next-hint">The leave type was added. Finish saving its rules below.</p> : null}
      <Field label="Name">
        <input
          disabled={createdId !== null}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Parental leave"
        />
      </Field>
      <Field label="Rules start on">
        <input
          type="date"
          value={f.valid_from}
          onChange={(e) => setF({ ...f, valid_from: e.target.value })}
        />
      </Field>
      <Check
        disabled={createdId !== null}
        label="Sensitive"
        hint="The reason for the leave is hidden in the team calendar — it just says Away."
        checked={sensitive}
        onChange={setSensitive}
      />
      <RuleFields f={f} setF={setF} />


    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Change rules from a date                                            */
/* ------------------------------------------------------------------ */

export function ChangeRulesModal({
  picker,
  t,
  businessDate,
  onClose,
  onDone,
}: {
  picker?: ReactNode;
  t: LeaveType;
  businessDate: string;
  onClose: () => void;
  onDone: (affected: { id: number; number: string }[]) => void;
}) {
  const { err, busy, run } = useSave();
  const cur = allVersions(t).at(-1) ?? currentVersion(t);
  const nextYear = Number(businessDate.slice(0, 4)) + 1;
  const [f, setF] = useState<RuleForm>(() =>
    defaultsFromPolicy(cur, cur ? `${nextYear}-01-01` : businessDate),
  );

  const usesBalance = f.uses_balance;
  const oldDays = cur ? cur.annual_entitlement_min / STANDARD_DAY_MINUTES : null;
  const newDays = usesBalance ? f.days_per_year : 0;
  const diff =
    cur && oldDays !== newDays
      ? `Days a year: ${oldDays} → ${newDays}`
      : cur && usesBalance !== cur.uses_balance
        ? usesBalance
          ? 'Now counts against a yearly allowance.'
          : 'No longer counts against a yearly allowance.'
        : null;

  return (
    <Modal title={`Change rules — ${t.name}`} onClose={onClose} wide footer={<> <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !f.valid_from}
          onClick={() =>
            void run(async () => {
              const r = await post<{ affected_future_requests?: { id: number; number: string }[] }>(
                `/leave-types/${t.id}/policies`,
                policyBody(f),
              );
              const affected = r.affected_future_requests ?? [];
              onDone(affected);
              return affected.length
                ? `Rules saved. ${plural(affected.length, 'future request')} may need re-checking.`
                : 'Rules saved.';
            })
          }
        >
          {busy ? 'Saving…' : 'Save'}
        </button>

       </>}>
      {picker ? <fieldset disabled={busy}>{picker}</fieldset> : null}
      {err ? <ErrBox error={err} /> : null}
      <Field label="New rules apply from" hint="Past requests keep the rules they were made under.">
        <input
          type="date"
          value={f.valid_from}
          onChange={(e) => setF({ ...f, valid_from: e.target.value })}
        />
      </Field>
      {diff ? <p className="next-hint">{diff}</p> : null}
      <RuleFields f={f} setF={setF} />
      <p className="muted small">
        If next year's days were already added, correct them under{' '}
        <Link to="/balances">Balances</Link>.
      </p>

    </Modal>
  );
}

/* ------------------------------------------------------------------ */
/* Rename                                                              */
/* ------------------------------------------------------------------ */

function RenameModal({
  t,
  onClose,
  onDone,
}: {
  t: LeaveType;
  onClose: () => void;
  onDone: () => void;
}) {
  const { err, busy, run } = useSave();
  const [name, setName] = useState(t.name);
  const [sensitive, setSensitive] = useState(t.sensitive);

  return (
    <Modal title={`Rename ${t.name}`} onClose={onClose} footer={<> <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !name.trim()}
          onClick={() =>
            void run(async () => {
              await put(`/leave-types/${t.id}`, {
                code: t.code,
                name: name.trim(),
                sensitive,
                active: t.active,
                expected_version: t.version,
              });
              onDone();
              return 'Saved.';
            })
          }
        >
          {busy ? 'Saving…' : 'Save'}
        </button>

       </>}>
      {err ? <ErrBox error={err} /> : null}
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Check
        label="Sensitive"
        hint="The reason for the leave is hidden in the team calendar."
        checked={sensitive}
        onChange={setSensitive}
      />

    </Modal>
  );
}
