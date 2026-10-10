import { useEffect, useRef, useState } from 'react';
import { api, ApiError, post, postForm, unwrapList } from '../api/client';
import type {
  EmployeeListItem,
  ImportBatch,
  ImportPreview,
  LeaveType,
  OrgUnit,
  Schedule,
} from '../api/types';
import {
  DataTable,
  Details,
  Empty,
  ErrBox,
  Field,
  Modal,
  useToast,
} from './ui';
import {
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtRange,
  importStatusLabel,
  importKindLabel,
  orgUnitName,
  plural,
} from '../lib/format';
import { IntentKeys } from '../lib/domain';
import { describeError } from '../lib/errors';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

export type ImportKind = 'employees' | 'opening_balances' | 'historical_leave';

const TITLES: Record<ImportKind, string> = {
  employees: 'Import people',
  opening_balances: 'Import opening balances',
  historical_leave: 'Import past leave',
};

interface Ctx {
  units: OrgUnit[];
  schedules: Schedule[];
  types: LeaveType[];
  people: EmployeeListItem[];
  today: string;
}

function dayLengthFor(staffNumber: string, ctx: Ctx): number {
  const person = ctx.people.find((p) => p.service_id === staffNumber);
  const versions = ctx.schedules.find((s) => s.id === person?.schedule?.id)?.versions ?? [];
  const version = versions.filter((v) => {
    const until = (v as { valid_to?: string | null }).valid_to;
    return v.valid_from <= ctx.today && (!until || until >= ctx.today);
  })
    .sort((a, b) => b.valid_from.localeCompare(a.valid_from) || b.id - a.id)[0];
  const week = version ? (Array.isArray(version.week) ? version.week : Object.values(version.week)) : [];
  return Math.max(...week, 0) || 480;
}

async function allItems<T>(path: string, query: Record<string, number> = {}): Promise<T[]> {
  const result: T[] = [];
  for (;;) {
    const data = await api<unknown>(path, { query: { ...query, limit: 500, offset: result.length } });
    const page = unwrapList<T>(data);
    result.push(...page);
    const total = data && typeof data === 'object' && 'total' in data ? Number(data.total) : result.length;
    if (!page.length || result.length >= total) return result;
  }
}

/* ------------------------------------------------------------------ */
/* Templates (generated client-side: header + one example row)         */
/* ------------------------------------------------------------------ */

export function templateFor(kind: ImportKind, ctx: Ctx): { name: string; csv: string } {
  const esc = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
  const row = (cells: (string | number)[]) => cells.map((c) => esc(String(c))).join(',');
  const unit = ctx.units[0]?.code ?? 'UNIT';
  const schedule = ctx.schedules[0]?.name ?? 'Standard week';
  const type = ctx.types.find((t) => t.uses_balance)?.name ?? ctx.types[0]?.name ?? 'Annual leave';
  switch (kind) {
    case 'employees':
      return {
        name: 'people-template.csv',
        csv:
          row(['staff_number', 'full_name', 'email', 'start_date', 'org_unit', 'schedule', 'manager_service_id']) +
          '\n' +
          row(['NPS-3001', 'Kim Tao', 'kim.tao@example.gov.nr', ctx.today, unit, schedule, '']),
      };
    case 'opening_balances':
      return {
        name: 'opening-balances-template.csv',
        csv:
          row(['staff_number', 'leave_type', 'year', 'days', 'basis']) +
          '\n' +
          row([ctx.people[0]?.service_id ?? 'NPS-1001', type, ctx.today.slice(0, 4), 12.5, 'Opening balance sheet']),
      };
    case 'historical_leave':
      return {
        name: 'past-leave-template.csv',
        csv:
          row(['staff_number', 'leave_type', 'start_date', 'end_date']) +
          '\n' +
          row([ctx.people[0]?.service_id ?? 'NPS-1001', ctx.types[0]?.code ?? 'ANNUAL', `${ctx.today.slice(0, 4)}-03-02`, `${ctx.today.slice(0, 4)}-03-06`]),
      };
  }
}

function downloadText(filename: string, text: string) {
  // A BOM makes Excel open the file as UTF-8 instead of garbling it.
  const blob = new Blob(['\uFEFF' + text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/* "Columns the file needs" — a small two-column table                  */
/* ------------------------------------------------------------------ */

function ColumnHelp({ kind }: { kind: ImportKind; ctx: Ctx }) {
  const rows: [string, string][] = kind === 'employees' ? [
    ['Staff number', 'A unique staff number for each person.'], ['Full name', 'The name shown in People.'],
    ['Employment date', 'First day employed, written as YYYY-MM-DD.'], ['Unit', 'The unit the person belongs to.'],
    ['Work pattern', 'The name of their work pattern.'], ['Email', 'Optional contact address.'], ['Manager', "Optional manager's staff number."],
  ] : kind === 'opening_balances' ? [
    ['Staff number', 'The person whose balance is being set.'], ['Leave type', 'The leave type name or code; letter case does not matter.'],
    ['Year', 'The year the starting balance belongs to.'], ['Days', 'Days in this person’s work pattern, including half-days such as 12.5.'],
    ['Reference', 'The document supporting the starting balance.'],
  ] : [['Staff number', 'The person who took the leave.'], ['Leave type', 'The type of leave taken.'], ['Dates', 'First and last day, written as YYYY-MM-DD.']];
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Column</th>
            <th>What it is</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([c, d]) => (
            <tr key={c}>
              <td className="nowrap">
                {c}
              </td>
              <td className="small">{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Preview rows → plain table                                          */
/* ------------------------------------------------------------------ */

type RowData = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);

const MISSING_WORD: Record<string, string> = {
  service_id: 'staff number',
  full_name: 'name',
  start_date: 'start date',
  end_date: 'end date',
  org_unit: 'unit',
  schedule: 'work pattern',
  leave_type: 'leave type',
  period_year: 'year',
  minutes: 'amount',
};

/** Server per-row error strings → plain problem descriptions. */
function plainProblem(e: string): string {
  let m: RegExpMatchArray | null;
  if ((m = e.match(/^missing ([a-z_]+)$/)))
    return `Missing ${MISSING_WORD[m[1]!] ?? 'required value'}`;
  if ((m = e.match(/^unknown service_id '(.+)'$/))) return `Unknown staff number ${m[1]}`;
  if ((m = e.match(/^unknown manager_service_id '(.+)'$/)))
    return `Unknown manager staff number ${m[1]}`;
  if ((m = e.match(/^unknown leave_type '(.+)'$/))) return "Choose a leave type from the template’s Technical details.";
  if ((m = e.match(/^unknown org_unit '(.+)'$/))) return "Choose a unit from the template’s Technical details.";
  if ((m = e.match(/^unknown schedule '(.+)'$/))) return `Unknown work pattern ${m[1]}`;
  if ((m = e.match(/^duplicate service_id '(.+)' in file$/)))
    return `Staff number ${m[1]} appears twice`;
  if (/^duplicate row in file/.test(e)) return 'The same row appears twice';
  if (/^bad minutes/.test(e)) return 'Amount must be a number';
  if (e === 'negative value') return 'Amount must not be negative';
  if ((m = e.match(/^bad period_year '(.+)'$/))) return `Year ${m[1]} must be a number`;
  if ((m = e.match(/^bad date '(.+)'$/))) return `Date ${m[1]} must be YYYY-MM-DD`;
  if (e === 'end_date before start_date') return 'The end date is before the start date';
  if (/^opening already posted/.test(e))
    return 'An opening balance for this person, type and year was already recorded';
  if (/no schedule|work schedule/i.test(e)) return 'No work pattern covers these dates. Set one in People first.';
  if (/no policy|no leave rule/i.test(e)) return 'No leave rule covers these dates. Add one in Settings first.';
  return describeError(new ApiError(422, 'validation', e)).message;
}

interface PreviewView {
  line: number;
  person: string;
  personSub?: string | undefined;
  cells: string[];
  problem: string;
}

function describeRows(kind: ImportKind, preview: ImportPreview, ctx: Ctx): PreviewView[] {
  const unitName = (id: number) => {
    const u = ctx.units.find((x) => x.id === id);
    return u ? orgUnitName(u.name) : '';
  };
  const typeName = (id: number) => ctx.types.find((t) => t.id === id)?.name ?? '';
  const personName = (sid: string) => ctx.people.find((p) => p.service_id === sid)?.full_name ?? '';

  return preview.rows.map((r) => {
    const d = (r.data ?? {}) as RowData;
    const problem = r.errors.map(plainProblem).join('; ');
    const sid = str(d['service_id']);
    if (kind === 'employees') {
      const name = str(d['full_name']);
      const unit = d['org_unit_id'] != null ? unitName(num(d['org_unit_id'])) : ctx.units.find((u) => u.code === str(d['org_unit']))?.name;
      const start = str(d['start_date']);
      return {
        line: r.line,
        person: name || sid || '—',
        personSub: name ? sid : '',
        cells: [start ? fmtDate(start) : '—', unit || '—'],
        problem,
      };
    }
    const lt = d['leave_type_id'] != null ? typeName(num(d['leave_type_id']))
      : ctx.types.find((t) => t.code === str(d['leave_type']))?.name;
    const name = personName(sid);
    if (kind === 'opening_balances') {
      const minutes = d['minutes'];
      const dayLength = dayLengthFor(sid, ctx);
      return {
        line: r.line,
        person: name || sid || '—',
        personSub: name ? sid : '',
        cells: [
          lt || '—',
          typeof minutes === 'number' ? fmtDuration(minutes, dayLength) : '—',
        ],
        problem,
      };
    }
    const from = str(d['start_date']);
    const to = str(d['end_date']);
    return {
      line: r.line,
      person: name || sid || '—',
      personSub: name ? sid : '',
      cells: [lt || '—', from && to ? fmtRange(from, to) : `${from || '—'} – ${to || '—'}`],
      problem,
    };
  });
}

const KIND_HEADERS: Record<ImportKind, string[]> = {
  employees: ['Start date', 'Unit'],
  opening_balances: ['Leave type', 'Days'],
  historical_leave: ['Leave type', 'Dates'],
};

/* ------------------------------------------------------------------ */
/* Dialog                                                              */
/* ------------------------------------------------------------------ */

export function ImportDialog({
  kind: initialKind,
  onClose,
  onDone,
}: {
  kind: ImportKind;
  onClose: () => void;
  onDone?: (() => void) | undefined;
}) {
  const toast = useToast();
  const { config } = useSession();
  const [kind, setKind] = useState<ImportKind>(initialKind);
  const [mode, setMode] = useState<'already_in_opening' | 'post_movements'>('already_in_opening');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  // Commit idempotency: one key per previewed batch, kept only while the
  // commit result is unconfirmed (network failure), then reset.
  const keys = useRef(new IntentKeys());
  const previewSequence = useRef(0);
  useEffect(() => () => { previewSequence.current++; }, []);

  const unitsQ = useApi(() => allItems<OrgUnit>('/org-units'), []);
  const schedQ = useApi(
    () => allItems<Schedule>('/schedules'),
    [],
  );
  const typesQ = useApi(() => api<LeaveType[]>('/leave-types'), []);
  const peopleQ = useApi(
    () => allItems<EmployeeListItem>('/employees', { include_inactive: 1 }),
    [],
  );
  const historyQ = useApi(
    () => allItems<ImportBatch>('/imports'),
    [],
  );

  const ctx: Ctx = {
    units: unitsQ.data ?? [],
    schedules: schedQ.data ?? [],
    types: typesQ.data ?? [],
    people: peopleQ.data ?? [],
    today: config?.business_date ?? '',
  };

  async function previewFile(f: File, m: string) {
    const sequence = ++previewSequence.current;
    setPreview(null);
    setBusy(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.set('file', f);
      fd.set('kind', kind);
      if (kind === 'historical_leave') fd.set('mode', m);
      const next = await postForm<ImportPreview>('/imports/preview', fd);
      if (previewSequence.current === sequence) setPreview(next);
    } catch (e) {
      if (previewSequence.current === sequence) setErr(e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e)));
    } finally {
      if (previewSequence.current === sequence) setBusy(false);
    }
  }

  function onFile(f: File | null) {
    previewSequence.current++;
    setFile(f);
    setErr(null);
    setBusy(false);
    setPreview(null);
    if (f) void previewFile(f, mode);
  }

  async function commit() {
    if (!preview || busy || preview.rows_total === 0 || preview.rows_valid !== preview.rows_total) return;
    setBusy(true);
    setErr(null);
    const intent = `import:${preview.batch_id}`;
    try {
      const r = await post<{ applied: number; skipped_duplicates: number }>(
        `/imports/${preview.batch_id}/commit`,
        {},
        keys.current.forIntent(intent),
      );
      keys.current.reset(intent);
      toast(
        `Imported ${plural(r.applied, 'row')}.` +
          (r.skipped_duplicates ? ` ${r.skipped_duplicates} were already in the system.` : ''),
      );
      onDone?.();
      onClose();
    } catch (e) {
      const ae = e instanceof ApiError ? e : new ApiError(0, 'unknown', String(e));
      if (ae.status !== 0) keys.current.reset(intent);
      setErr(ae);
    } finally {
      setBusy(false);
    }
  }

  const problems = preview ? preview.rows_total - preview.rows_valid : 0;
  const canCommit = !!preview && preview.rows_total > 0 && problems === 0;
  const views = preview ? describeRows(kind, preview, ctx) : [];
  const cols = KIND_HEADERS[kind];

  return (
    <Modal
      title={TITLES[kind]}
      onClose={() => { if (!busy) onClose(); }}
      wide
      footer={
        <>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          {preview ? (
            <button
              type="button"
              className="btn"
              disabled={busy || !canCommit}
              onClick={() => void commit()}
            >
              {busy ? 'Importing…' : `Import ${plural(preview.rows_valid, 'row')}`}
            </button>
          ) : null}
        </>
      }
    >
      <fieldset disabled={busy} className="stack">
        <legend>What to import</legend>
        {(initialKind === 'employees' ? ['employees'] as const : ['opening_balances', 'historical_leave'] as const).map((value) => (
          <label key={value}>
            <input type="radio" name="import-kind" checked={kind === value} onChange={() => {
              previewSequence.current++;
              setKind(value); setPreview(null); setFile(null); setErr(null); setBusy(false);
            }} />{' '}
            {value === 'historical_leave' ? 'Past leave' : importKindLabel(value)} — {value === 'employees' ? 'Add people to the staff list.' : value === 'opening_balances' ? 'Set the leave left at the start of a year.' : 'Record leave taken before using this desk.'}
          </label>
        ))}
      </fieldset>
      <p className="muted small">
        1 · Prepare the CSV —{' '}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy || !ctx.today || unitsQ.loading || schedQ.loading || typesQ.loading || !!unitsQ.error || !!schedQ.error || !!typesQ.error}
          onClick={() => {
            const t = templateFor(kind, ctx);
            downloadText(t.name, t.csv);
          }}
        >
          Download the template
        </button>
      </p>
      <ColumnHelp kind={kind} ctx={ctx} />
      <Details title="Technical details">
        <p>Use the template’s column headers. Older files using service_id, period_year and minutes are also accepted. Units use the codes below.</p>
        <pre>{templateFor(kind, ctx).csv.split('\n')[0]}</pre>
        {kind === 'opening_balances' ? <p>Use exactly one amount column: days (12 or 12.5) or whole minutes. Days use each person’s current work pattern. Leave types accept names or codes.</p> : null}
        <table><thead><tr><th>Name</th><th>CSV value</th></tr></thead><tbody>
          {ctx.types.map(t => <tr key={`type-${t.id}`}><td>{t.name}</td><td>{t.code}</td></tr>)}
          {ctx.units.map(u => <tr key={`unit-${u.id}`}><td>{u.name}</td><td>{u.code}</td></tr>)}
        </tbody></table>
      </Details>

      {kind === 'historical_leave' ? (
        <fieldset disabled={busy}>
          <legend>Are these days already in the opening balances?</legend>
          <div>
            <label>
              <input
                type="radio"
                name="hist-mode"
                checked={mode === 'already_in_opening'}
                onChange={() => {
                  setMode('already_in_opening');
                  if (file) void previewFile(file, 'already_in_opening');
                }}
              />{' '}
              Yes — just record them
            </label>
          </div>
          <div>
            <label>
              <input
                type="radio"
                name="hist-mode"
                checked={mode === 'post_movements'}
                onChange={() => {
                  setMode('post_movements');
                  if (file) void previewFile(file, 'post_movements');
                }}
              />{' '}
              No — also deduct them
            </label>
          </div>
        </fieldset>
      ) : null}

      <Field label="2 · Choose the CSV file">
        <input
          key={kind}
          type="file"
          disabled={busy || peopleQ.loading || typesQ.loading || schedQ.loading}
          accept=".csv,text/csv"
          onChange={(e) => onFile(e.target.files?.[0] ?? null)}
        />
      </Field>

      {busy && file && !preview ? <p className="muted small">Checking the file…</p> : null}
      {err ? <ErrBox error={err} /> : null}
      {unitsQ.error ? <ErrBox error={unitsQ.error} /> : null}
      {schedQ.error ? <ErrBox error={schedQ.error} /> : null}
      {typesQ.error ? <ErrBox error={typesQ.error} /> : null}
      {peopleQ.error ? <ErrBox error={peopleQ.error} /> : null}

      {preview ? (
        <>
          <p>
            {problems === 0
              ? `All ${plural(preview.rows_total, 'row')} ready to import.`
              : `${plural(preview.rows_valid, 'row')} ready · ${plural(problems, 'problem')} to fix first.`}
          </p>
          {preview.rows.length ? (
            <DataTable<PreviewView>
              columns={[
                { label: 'Line', className: 'num', render: (r) => r.line },
                {
                  label: 'Person',
                  title: true,
                  render: (r) => (
                    <>
                      {r.person}
                      {r.personSub ? <div className="muted small">{r.personSub}</div> : null}
                    </>
                  ),
                },
                ...cols.map((label, i) => ({
                  label,
                  render: (r: PreviewView) => r.cells[i] ?? '—',
                })),
                {
                  label: 'Problem',
                  render: (r) =>
                    r.problem ? <span className="tag tag-err">{r.problem}</span> : '—',
                },
              ]}
              rows={views}
            />
          ) : (
            <Empty>The file has no data rows.</Empty>
          )}
        </>
      ) : null}

      <Details title="Previous imports" count={historyQ.data?.length}>
          {historyQ.error ? <ErrBox error={historyQ.error} /> : null}
          {historyQ.loading ? <p className="muted small">Loading previous imports…</p> : null}
          {historyQ.data ?
          <DataTable<ImportBatch>
            columns={[
              { label: 'Kind', render: (b) => importKindLabel(b.kind) },
              {
                label: 'Date',
                title: true,
                render: (b) => (
                  <>
                    {fmtDateTime(b.created_at)}
                    {b.filename ? <div className="muted small">{b.filename}</div> : null}
                  </>
                ),
              },
              { label: 'Status', render: (b) => importStatusLabel(b.status) },
              {
                label: 'Rows in file',
                className: 'num',
                render: (b) => b.rows_total ?? '—',
              },
            ]}
            rows={historyQ.data}
          /> : null}
      </Details>
    </Modal>
  );
}
