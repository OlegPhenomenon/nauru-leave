import { useState } from 'react';
import { post } from '../../api/client';
import type { Schedule, ScheduleVersion } from '../../api/types';
import {
  Details,
  EmptyState,
  ErrBox,
  Field,
  Loading,
  Modal,
  PageHeader,
} from '../../components/ui';
import { fmtDate } from '../../lib/format';
import { useSession } from '../../lib/session';
import { readAll } from './data';
import { useApi } from '../../lib/useApi';
import { AffectedRequests, type AffectedRequest, useSave } from './shared';

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const PRESETS: { label: string; hours: number[] }[] = [
  { label: 'Weekdays — 8 hours a day', hours: [8, 8, 8, 8, 8, 0, 0] },
  { label: 'Monday–Thursday — 6 hours a day', hours: [6, 6, 6, 6, 0, 0, 0] },
  { label: 'Every day — 8 hours', hours: [8, 8, 8, 8, 8, 8, 8] },
];

function weekArray(w: ScheduleVersion['week']): number[] {
  if (Array.isArray(w)) return w;
  return [w.mon, w.tue, w.wed, w.thu, w.fri, w.sat, w.sun];
}

/** "Monday–Friday, 8 hours a day" / "Monday 8 h · Friday 4 h" — never minutes. */
function weekSentence(weekMin: number[]): string {
  const parts = weekMin.map((m, i) => ({ day: DAY_NAMES[i]!, idx: i, hours: m / 60 }));
  const working = parts.filter((p) => p.hours > 0);
  if (!working.length) return 'No working days';
  if (working.every((p) => p.hours === working[0]!.hours)) {
    const h = working[0]!.hours;
    const hTxt = `${h} ${h === 1 ? 'hour' : 'hours'} a day`;
    if (working.length === 7) return `Every day, ${hTxt}`;
    if (working.length === 5 && working.every((p) => p.idx < 5)) return `Monday–Friday, ${hTxt}`;
    if (working.at(-1)!.idx - working[0]!.idx === working.length - 1) {
      return `${working[0]!.day}–${working.at(-1)!.day}, ${hTxt}`;
    }
    return `${working.map((p) => p.day).join(', ')}, ${hTxt}`;
  }
  return working.map((p) => `${p.day} ${p.hours} h`).join(' · ');
}

/** The version in force on `today` (or the latest known). */
function inForce(s: Schedule, today: string): ScheduleVersion | null {
  const versions = [...(s.versions ?? [])].sort((a, b) => a.valid_from.localeCompare(b.valid_from));
  return versions.filter((v) => v.valid_from <= today).at(-1) ?? null;
}

function weekBody(hours: number[]) {
  return {
    mon: Math.round(hours[0]! * 60),
    tue: Math.round(hours[1]! * 60),
    wed: Math.round(hours[2]! * 60),
    thu: Math.round(hours[3]! * 60),
    fri: Math.round(hours[4]! * 60),
    sat: Math.round(hours[5]! * 60),
    sun: Math.round(hours[6]! * 60),
  };
}

/** Preset picker + per-day hours in one block. */
function WeekFields({
  hours,
  setHours,
}: {
  hours: number[];
  setHours: (h: number[]) => void;
}) {
  const preset = PRESETS.findIndex((p) => p.hours.every((h, i) => h === hours[i]));
  return (
    <>
      <fieldset><legend>Start from a preset</legend>
        <span className="field-row">
          {PRESETS.map((p, i) => (
            <label key={p.label}>
              <input
                type="radio"
                name="pattern-preset"
                checked={preset === i}
                onChange={() => setHours([...p.hours])}
              />{' '}
              {p.label}
            </label>
          ))}
          <label>
            <input type="radio" name="pattern-preset" checked={preset === -1} readOnly /> Custom
          </label>
        </span>
      </fieldset>
      <fieldset><legend>Hours per day</legend>
        <span className="field-row">
          {DAY_NAMES.map((d, i) => (
            <label key={d} className="muted small">
              {d}
              <br />
              <input
                type="number"
                min={0}
                max={24}
                step={0.5}
                value={hours[i]}
                aria-label={`${d} hours`}
                onChange={(e) => {
                  const next = [...hours];
                  next[i] = Number(e.target.value);
                  setHours(next);
                }}
              />
            </label>
          ))}
        </span>
      </fieldset>
    </>
  );
}

export default function WorkPatterns() {
  const { me, config } = useSession();
  const canEdit = me?.roles.some((r) => r.role === 'hr' && r.scope_org_unit_id === null) ?? false;
  const today = config?.business_date ?? '';
  const q = useApi(() => readAll<Schedule>('/schedules'), []);
  const [newOpen, setNewOpen] = useState(false);
  const [versionFor, setVersionFor] = useState<Schedule | null>(null);
  const [affected, setAffected] = useState<AffectedRequest[]>([]);

  if (q.loading) return <Loading />;
  if (q.error) return <ErrBox error={q.error} />;

  const patterns = q.data ?? [];

  return (
    <>
      <PageHeader
        title="Work patterns"
        subtitle="The days and hours each working week is based on."
        primary={
          canEdit ? (
            <button type="button" className="btn" onClick={() => setNewOpen(true)}>
              Add work pattern
            </button>
          ) : undefined
        }
      />
      <AffectedRequests requests={affected} />
      {patterns.length === 0 ? (
        <EmptyState
          text="No work patterns yet."

        />
      ) : (
        <div className="card-grid">
          {patterns.map((s) => {
            const cur = inForce(s, today);
            const versions = [...(s.versions ?? [])].sort((a, b) =>
              b.valid_from.localeCompare(a.valid_from),
            );
            return (
              <div key={s.id} className="card">
                <h3>{s.name}</h3>
                <p>{cur ? weekSentence(weekArray(cur.week)) : 'No work pattern in force yet.'}</p>
                {canEdit ? (
                  <p>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setVersionFor(s)}
                    >
                      New version from a date…
                    </button>
                  </p>
                ) : null}
                {versions.length ? (
                  <Details title="Pattern history" count={versions.length}>
                    <ul className="sentence-list">
                      {versions.map((v) => (
                        <li key={v.id}>
                          <span>
                            From {fmtDate(v.valid_from)} — {weekSentence(weekArray(v.week))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </Details>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {newOpen && today ? (
        <PatternModal
          businessDate={today}
          onClose={() => setNewOpen(false)}
          onDone={() => {
            setNewOpen(false);
            q.reload();
          }}
        />
      ) : null}
      {versionFor && today ? (
        <VersionModal
          s={versionFor}
          businessDate={today}
          onClose={() => setVersionFor(null)}
          onDone={(requests) => {
            setAffected(requests);
            setVersionFor(null);
            q.reload();
          }}
        />
      ) : null}
    </>
  );
}

export function PatternModal({
  businessDate,
  onClose,
  onDone,
}: {
  businessDate: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { err, busy, run } = useSave();
  const [name, setName] = useState('');
  const [validFrom, setValidFrom] = useState(businessDate);
  const [hours, setHours] = useState<number[]>([...PRESETS[0]!.hours]);

  return (
    <Modal title="Add work pattern" onClose={onClose} wide footer={<> <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !name.trim() || !validFrom}
          onClick={() =>
            void run(async () => {
              await post('/schedules', { name: name.trim(), valid_from: validFrom, week: weekBody(hours) });
              onDone();
              return `${name.trim()} saved.`;
            })
          }
        >
          {busy ? 'Saving…' : 'Save work pattern'}
        </button>

       </>}>
      {err ? <ErrBox error={err} /> : null}
      <Field label="Name" hint="e.g. Office staff, Site crews">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Applies from">
        <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
      </Field>
      <WeekFields hours={hours} setHours={setHours} />

    </Modal>
  );
}

function VersionModal({
  s,
  businessDate,
  onClose,
  onDone,
}: {
  s: Schedule;
  businessDate: string;
  onClose: () => void;
  onDone: (requests: AffectedRequest[]) => void;
}) {
  const { err, busy, run } = useSave();
  const cur = inForce(s, businessDate);
  const latest = [...(s.versions ?? [])].sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0];
  const nextDate = latest && latest.valid_from >= businessDate ? new Date(`${latest.valid_from}T00:00:00Z`) : null;
  nextDate?.setUTCDate(nextDate.getUTCDate() + 1);
  const [validFrom, setValidFrom] = useState(nextDate?.toISOString().slice(0, 10) ?? businessDate);
  const [hours, setHours] = useState<number[]>(() =>
    cur ? weekArray(cur.week).map((m) => m / 60) : [...PRESETS[0]!.hours],
  );

  return (
    <Modal title={`New version — ${s.name}`} onClose={onClose} wide footer={<> <button type="button" className="btn btn-secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !validFrom}
          onClick={() =>
            void run(async () => {
              const result = await post<{ affected_future_requests?: AffectedRequest[] }>(`/schedules/${s.id}/versions`, {
                valid_from: validFrom,
                week: weekBody(hours),
                expected_version: s.version,
              });
              onDone(result.affected_future_requests ?? []);
              return 'New version saved.';
            })
          }
        >
          {busy ? 'Saving…' : 'Save version'}
        </button>

       </>}>
      {err ? <ErrBox error={err} /> : null}
      <Field label="New hours apply from" hint="People keep their past days as they were.">
        <input type="date" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
      </Field>
      <WeekFields hours={hours} setHours={setHours} />

    </Modal>
  );
}

