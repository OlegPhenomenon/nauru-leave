import type { Part } from '../api/types';
import { partLabel } from '../lib/format';

/** The same half-day choices on a new request and a change of dates. */
export function DayParts({ single, startPart, endPart, onChange, prefix }: {
  single: boolean;
  startPart: Part;
  endPart: Part;
  onChange: (start: Part, end: Part) => void;
  prefix: string;
}) {
  function group(label: string, parts: Part[], value: Part, name: string, change: (part: Part) => void) {
    return <fieldset><legend>{label}</legend><div className="seg" role="radiogroup" aria-label={label}>
      {parts.map(part => <label key={part} className={`seg-opt${value === part ? ' on' : ''}`}>
        <input type="radio" name={name} checked={value === part} onChange={() => change(part)} />{partLabel(part)}
      </label>)}
    </div></fieldset>;
  }
  return <div className="form-grid">
    {group(single ? 'Part of day' : 'First day part', single ? ['full', 'am', 'pm'] : ['full', 'pm'], startPart, `${prefix}-first`, part => onChange(part, single ? part : endPart))}
    {!single ? group('Last day part', ['full', 'am'], endPart, `${prefix}-last`, part => onChange(startPart, part)) : null}
  </div>;
}
