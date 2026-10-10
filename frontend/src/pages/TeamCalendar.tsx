import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import type { CalendarAbsence, CalendarResp } from '../api/types';
import {
  EmptyState,
  ErrBox,
  Field,
  Loading,
  PageHeader,
} from '../components/ui';
import {
  fmtDate,
  fmtDay,
  fmtRange,
  fmtWeekday,
  orgUnitName,
  partLabel,
  todayPlus,
} from '../lib/format';
import { isAuditor, isHr, isTechAdmin } from '../lib/nav';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import './TeamCalendar.css';

type View = 'week' | 'month';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function weekdayOf(d: string): number {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, dd!)).getUTCDay(); // 0 = Sunday
}

function mondayOf(d: string): string {
  return todayPlus(d, -((weekdayOf(d) + 6) % 7));
}

function monthStart(d: string) {
  return `${d.slice(0, 7)}-01`;
}
function monthEnd(d: string) {
  const [y, m] = d.split('-').map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return `${d.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}
function monthLabel(d: string) {
  const [y, m] = d.split('-').map(Number);
  return `${MONTH_NAMES[m! - 1]} ${y}`;
}

interface Run {
  from: string;
  to: string;
  part: string;
  state: 'approved' | 'pending';
  label: string;
  requestId: number | null;
}

/** Merge consecutive same-kind days into one range per request. */
function groupRuns(absences: CalendarAbsence[]): Run[] {
  const runs: Run[] = [];
  for (const a of [...absences].sort((x, y) => (x.date < y.date ? -1 : 1))) {
    const last = runs[runs.length - 1];
    if (
      last &&
      last.part === a.part &&
      last.state === a.state &&
      last.label === a.label &&
      last.requestId === a.request_id &&
      todayPlus(last.to, 1) === a.date
    ) {
      last.to = a.date;
    } else {
      runs.push({
        from: a.date,
        to: a.date,
        part: a.part,
        state: a.state,
        label: a.label,
        requestId: a.request_id,
      });
    }
  }
  return runs;
}

export default function TeamCalendar() {
  const { config, me } = useSession();
  const today = config?.business_date ?? new Date().toISOString().slice(0, 10);

  // Team default: everyone's for office roles, own unit otherwise.
  const staffViewer = !!me && (isHr(me) || isAuditor(me) || isTechAdmin(me));
  const ownUnit = me?.employee?.org_unit?.id ?? null;
  const [team, setTeam] = useState(staffViewer || !ownUnit ? '' : String(ownUnit));

  const [view, setView] = useState<View>('week');
  const [anchor, setAnchor] = useState(mondayOf(today));

  const thisMonday = mondayOf(today);
  const nextMonday = todayPlus(thisMonday, 7);

  const [from, to] = useMemo(
    () =>
      view === 'week'
        ? [anchor, todayPlus(anchor, 6)]
        : [monthStart(anchor), monthEnd(anchor)],
    [anchor, view],
  );

  const { data, error, loading } = useApi(
    () => api<CalendarResp>('/calendar', { query: { org_unit_id: team || undefined, from, to } }),
    [from, to, team],
  );

  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = from; d <= to; d = todayPlus(d, 1)) out.push(d);
    return out;
  }, [from, to]);

  const people = useMemo(
    () =>
      [...(data?.people ?? [])].sort((a, b) =>
        a.employee.full_name.localeCompare(b.employee.full_name),
      ),
    [data],
  );

  function shift(dir: -1 | 1) {
    if (view === 'month') {
      const [y, m] = anchor.split('-').map(Number);
      const nm = m! + dir;
      const ny = y! + Math.floor((nm - 1) / 12);
      const mm = ((nm - 1 + 12) % 12) + 1;
      setAnchor(`${ny}-${String(mm).padStart(2, '0')}-01`);
    } else {
      setAnchor(todayPlus(anchor, dir * 7));
    }
  }

  function show(which: 'this' | 'next' | 'month') {
    if (which === 'month') {
      setView('month');
      setAnchor(monthStart(today));
    } else {
      setView('week');
      setAnchor(which === 'this' ? thisMonday : nextMonday);
    }
  }

  const teamName =
    team === ''
      ? 'the service'
      : orgUnitName(
          (data?.org_units ?? []).find((u) => String(u.id) === team)?.name ?? 'this team',
        );
  const countsByDate = useMemo(
    () => new Map((data?.counts ?? []).map((c) => [c.date, c])),
    [data],
  );

  const tabCls = (active: boolean) => (active ? 'active' : '');

  return (
    <>
      <PageHeader title="Who's away" subtitle="Approved leave and requests waiting for approval." />

      <div className="tabs" role="tablist" aria-label="Period">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'week' && anchor === thisMonday}
          className={tabCls(view === 'week' && anchor === thisMonday)}
          onClick={() => show('this')}
        >
          This week
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'week' && anchor === nextMonday}
          className={tabCls(view === 'week' && anchor === nextMonday)}
          onClick={() => show('next')}
        >
          Next week
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'month'}
          className={tabCls(view === 'month')}
          onClick={() => show('month')}
        >
          Month
        </button>
      </div>

      <div className="panel">
        <div className="toolbar cal-toolbar">
          <div className="cal-period">
          <button
            type="button"
            className="btn btn-secondary"
            aria-label="Earlier"
            onClick={() => shift(-1)}
          >
            ‹
          </button>
          <strong className="cal-range">
            {view === 'month' ? monthLabel(anchor) : fmtRange(from, to)}
          </strong>
          <button
            type="button"
            className="btn btn-secondary"
            aria-label="Later"
            onClick={() => shift(1)}
          >
            ›
          </button>
          </div>
            <Field label="Team">
              <select value={team} onChange={(e) => setTeam(e.target.value)}>
                <option value="">Everyone</option>
                {(data?.org_units ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {orgUnitName(u.name)}
                  </option>
                ))}
              </select>
            </Field>
        </div>

        {loading ? <Loading /> : null}
        {error ? <ErrBox error={error} /> : null}
        {data && people.length === 0 && !loading ? (
          <EmptyState text={`Nobody in ${teamName} is away ${fmtRange(from, to)}.`} />
        ) : null}

        {data && view === 'week' && people.length > 0 ? (
          <ul className="away-list">
            {people.map((p) =>
              groupRuns(p.absences).map((r, i) => {
                const masked = r.requestId === null;
                const when =
                  r.from === r.to
                    ? fmtDay(r.from)
                    : `${fmtDay(r.from)} – ${fmtDay(r.to)}`;
                const what = masked
                  ? 'Away'
                  : `${r.label} · ${r.state === 'approved' ? 'Approved' : 'Waiting for decision'}`;
                const inner = (
                  <>
                    <span className="who">{p.employee.full_name}</span>
                    <span className="when">
                      {when}
                      {r.part !== 'full' ? `, ${partLabel(r.part).toLowerCase()}` : ''}
                    </span>
                    <span className="what">{what}</span>
                  </>
                );
                return (
                  <li key={`${p.employee.id}-${i}`}>
                    {r.requestId ? (
                      <Link to={`/requests/${r.requestId}`}>{inner}</Link>
                    ) : (
                      <span className="row">{inner}</span>
                    )}
                  </li>
                );
              }),
            )}
          </ul>
        ) : null}

        {data && view === 'month' && people.length > 0 ? (
          <div className="cal-scroll" role="region" aria-label="Monthly absences; scroll to see all dates" tabIndex={0}>
            <div className="cal-legend">
              <span>
                <span className="sw sw-a" />
                Solid = approved
              </span>
              <span>
                <span className="sw sw-p" />
                Striped = waiting for approval
              </span>
              {people.some((p) => p.absences.some((a) => a.request_id === null)) ? (
                <span>Details of some absences are hidden.</span>
              ) : null}
            </div>
            <table className="cal">
              <thead>
                <tr>
                  <th className="cal-name">Person</th>
                  {days.map((d) => {
                    const we = weekdayOf(d) === 0 || weekdayOf(d) === 6;
                    const c = countsByDate.get(d);
                    const tip =
                      c && (c.approved || c.pending)
                        ? `${fmtDate(d)} — ${c.approved} away · ${c.pending} waiting`
                        : fmtDate(d);
                    return (
                      <th
                        key={d}
                        title={tip}
                        className={`${we ? 'cal-we' : ''} ${d === today ? 'cal-today' : ''}`}
                      >
                        {fmtWeekday(d).slice(0, 2)}
                        <br />
                        {Number(d.slice(8))}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {people.map((p) => {
                  const byDate = new Map(p.absences.map((a) => [a.date, a]));
                  return (
                    <tr key={p.employee.id}>
                      <td className="cal-name">{p.employee.full_name}</td>
                      {days.map((d) => {
                        const a = byDate.get(d);
                        const we = weekdayOf(d) === 0 || weekdayOf(d) === 6;
                        const todayCls = d === today ? 'cal-today' : '';
                        if (!a) {
                          return <td key={d} className={we ? 'cal-we' : todayCls} />;
                        }
                        const word = a.state === 'approved' ? 'Away' : 'Pending';
                        return (
                          <td
                            key={d}
                            className={`${a.state === 'approved' ? 'cal-a' : 'cal-p'} ${todayCls}`}
                            title={`${a.label} — ${word}`}
                          >
                            {a.request_id ? (
                              <Link to={`/requests/${a.request_id}`} aria-label={`${p.employee.full_name}, ${fmtDay(d)}: ${a.label}, ${word}`}><span className="visually-hidden">{word}</span></Link>
                            ) : (
                              <span className="visually-hidden">{word}</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </>
  );
}
