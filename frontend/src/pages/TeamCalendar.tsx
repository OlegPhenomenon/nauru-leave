import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import type { CalendarResp } from '../api/types';
import { Empty, ErrBox, Field, Loading } from '../components/ui';
import { fmtDate, fmtWeekday, todayPlus } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

type View = 'month' | 'fortnight';

function monthStart(d: string) {
  return `${d.slice(0, 7)}-01`;
}
function monthEnd(d: string) {
  const [y, m] = d.split('-').map(Number);
  const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return `${d.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

export default function TeamCalendar() {
  const { config } = useSession();
  const today = config?.business_date ?? new Date().toISOString().slice(0, 10);
  const [view, setView] = useState<View>('month');
  const [anchor, setAnchor] = useState(today);
  const [orgUnit, setOrgUnit] = useState('');

  const [from, to] = useMemo(() => {
    if (view === 'month') return [monthStart(anchor), monthEnd(anchor)];
    return [anchor, todayPlus(anchor, 13)];
  }, [anchor, view]);

  const { data, error, loading } = useApi(
    () => api<CalendarResp>('/calendar', { query: { org_unit_id: orgUnit || undefined, from, to } }),
    [from, to, orgUnit],
  );

  const days = useMemo(() => {
    const out: string[] = [];
    for (let d = from; d <= to; d = todayPlus(d, 1)) out.push(d);
    return out;
  }, [from, to]);

  function shift(dir: -1 | 1) {
    if (view === 'month') {
      const [y, m] = anchor.split('-').map(Number);
      const nm = m! + dir;
      const ny = y! + Math.floor((nm - 1) / 12);
      const mm = ((nm - 1 + 12) % 12) + 1;
      setAnchor(`${ny}-${String(mm).padStart(2, '0')}-01`);
    } else {
      setAnchor(todayPlus(anchor, dir * 14));
    }
  }

  return (
    <>
      <h1>Team calendar</h1>
      <div className="panel">
        <div className="toolbar">
          <Field label="View">
            <select value={view} onChange={(e) => setView(e.target.value as View)}>
              <option value="month">Month</option>
              <option value="fortnight">Two weeks</option>
            </select>
          </Field>
          <Field label="Org unit">
            <select value={orgUnit} onChange={(e) => setOrgUnit(e.target.value)}>
              <option value="">All units</option>
              {data?.org_units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          <div className="btn-row" style={{ marginTop: 0 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => shift(-1)}>
              ‹ Earlier
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setAnchor(today)}>
              Today
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => shift(1)}>
              Later ›
            </button>
          </div>
          <span className="muted">
            {fmtDate(from)} – {fmtDate(to)}
          </span>
        </div>
        <div className="cal-legend" aria-label="Legend">
          <span>
            <span className="sw sw-a" /> Approved absence
          </span>
          <span>
            <span className="sw sw-p" /> Pending (not yet decided)
          </span>
          <span>“am”/“pm” = half day · “Away” = details restricted</span>
        </div>

        {loading ? <Loading /> : null}
        {error ? <ErrBox error={error} /> : null}
        {data && data.people.length === 0 ? <Empty>No people in this scope.</Empty> : null}
        {data && data.people.length > 0 ? (
          <div className="cal-scroll">
            <table className="cal">
              <thead>
                <tr>
                  <th className="cal-name">Person</th>
                  {days.map((d) => (
                    <th key={d} title={fmtDate(d)}>
                      {fmtWeekday(d).slice(0, 2)}
                      <br />
                      {Number(d.slice(8))}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => {
                  const byDate = new Map(p.absences.map((a) => [a.date, a]));
                  return (
                    <tr key={p.employee.id}>
                      <td className="cal-name">{p.employee.full_name}</td>
                      {days.map((d) => {
                        const a = byDate.get(d);
                        if (!a) return <td key={d} className="cal-off" />;
                        const cls = a.state === 'approved' ? 'cal-a' : 'cal-p';
                        // The API masks sensitive absences (e.g. medical) with the label
                        // "Away" — show the word, not just a dot, so the day reads plainly.
                        const masked = a.label === 'Away' || !a.request_id;
                        const inner = masked
                          ? `${a.label}${a.part !== 'full' ? ` ${a.part}` : ''}`
                          : `${a.state === 'approved' ? '●' : '◐'}${a.part !== 'full' ? ` ${a.part}` : ''}`;
                        return (
                          <td key={d} className={cls} title={`${a.label} (${a.state})`}>
                            {a.request_id ? (
                              <Link to={`/requests/${a.request_id}`}>{inner}</Link>
                            ) : (
                              <span>{inner}</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                <tr>
                  <td className="cal-name">
                    <strong>Away (approved / pending)</strong>
                  </td>
                  {days.map((d) => {
                    const c = data.counts.find((x) => x.date === d);
                    return (
                      <td key={d} className="muted">
                        {c && (c.approved || c.pending) ? `${c.approved}/${c.pending}` : ''}
                      </td>
                    );
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </>
  );
}
