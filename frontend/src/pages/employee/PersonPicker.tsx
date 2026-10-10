// Searchable employee picker for the HR paper-form entry. The list is
// grouped by unit and filtered as you type; the signed-in user is never
// offered (they file for themselves in the normal form).

import { useMemo, useRef, useState } from 'react';
import type { EmployeeListItem } from '../../api/types';
import { orgUnitName } from '../../lib/format';

export function PersonPicker({
  people,
  value,
  onChange,
}: {
  people: EmployeeListItem[];
  value: number;
  onChange: (id: number) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const selected = people.find((p) => p.id === value) ?? null;

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const list = needle
      ? people.filter((p) =>
          `${p.full_name} ${p.service_id} ${p.org_unit?.name ?? ''}`
            .toLowerCase()
            .includes(needle),
        )
      : people;
    return [...list].sort((a, b) => {
      const ua = a.org_unit ? orgUnitName(a.org_unit.name) : '';
      const ub = b.org_unit ? orgUnitName(b.org_unit.name) : '';
      return ua.localeCompare(ub) || a.full_name.localeCompare(b.full_name);
    });
  }, [people, query]);

  const groups = useMemo(() => {
    const out: { unit: string; items: EmployeeListItem[] }[] = [];
    for (const p of matches.slice(0, 30)) {
      const unit = p.org_unit ? orgUnitName(p.org_unit.name) : 'No unit';
      const g = out[out.length - 1];
      if (g && g.unit === unit) g.items.push(p);
      else out.push({ unit, items: [p] });
    }
    return out;
  }, [matches]);

  function pick(p: EmployeeListItem) {
    onChange(p.id);
    setQuery('');
    setOpen(false);
  }

  if (selected && !open) {
    return (
      <div className="picker-selected">
        <span>
          <strong>{selected.full_name}</strong>
          <span className="muted">
            {' '}
            · {selected.org_unit ? orgUnitName(selected.org_unit.name) : 'No unit'} ·{' '}
            {selected.service_id}
          </span>
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            onChange(0);
            setOpen(true);
          }}
        >
          Change
        </button>
      </div>
    );
  }

  let flatIndex = -1;

  return (
    <div className="picker" ref={boxRef}>
      <input
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls="person-picker-list"
        aria-autocomplete="list"
        placeholder="Type a name…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          // Delay so a mousedown on an option can still pick it.
          window.setTimeout(() => {
            if (!boxRef.current?.contains(document.activeElement)) setOpen(false);
          }, 120);
        }}
        onKeyDown={(e) => {
          const flat = groups.flatMap((g) => g.items);
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, flat.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const p = flat[active] ?? flat[0];
            if (p) pick(p);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open ? (
        <div className="picker-list" role="listbox" id="person-picker-list">
          {groups.length === 0 ? (
            <div className="picker-empty muted">Nobody matches “{query}”.</div>
          ) : null}
          {groups.map((g) => (
            <div key={g.unit}>
              <div className="picker-group">{g.unit}</div>
              {g.items.map((p) => {
                flatIndex += 1;
                const idx = flatIndex;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    aria-selected={p.id === value}
                    className={`picker-opt${idx === active ? ' active' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pick(p);
                    }}
                    onMouseEnter={() => setActive(idx)}
                  >
                    {p.full_name}
                    <span className="muted"> · {p.service_id}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {matches.length > 30 ? (
            <div className="picker-empty muted">
              {matches.length - 30} more — keep typing to narrow it down.
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
