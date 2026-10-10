import type { ReactNode } from 'react';
import { Navigate, NavLink, useParams } from 'react-router';
import { isHr } from '../lib/nav';
import { useSession } from '../lib/session';
import './Settings.css';
import ApprovalRoute from './settings/ApprovalRoute';
import Holidays from './settings/Holidays';
import LeaveTypes from './settings/LeaveTypes';
import Overview from './settings/Overview';
import StandIns from './settings/StandIns';
import UsersAccess from './settings/UsersAccess';
import WorkPatterns from './settings/WorkPatterns';

interface Section {
  slug: string;
  label: string;
  hrOnly: boolean;
  render: () => ReactNode;
}

const SECTIONS: Section[] = [
  { slug: 'overview', label: 'Overview', hrOnly: true, render: () => <Overview /> },
  { slug: 'leave-types', label: 'Leave types', hrOnly: true, render: () => <LeaveTypes /> },
  { slug: 'schedules', label: 'Work patterns', hrOnly: true, render: () => <WorkPatterns /> },
  { slug: 'holidays', label: 'Public holidays', hrOnly: true, render: () => <Holidays /> },
  { slug: 'route', label: 'Approval route', hrOnly: true, render: () => <ApprovalRoute /> },
  { slug: 'delegations', label: 'Stand-ins', hrOnly: false, render: () => <StandIns /> },
  { slug: 'users', label: 'Users & access', hrOnly: false, render: () => <UsersAccess /> },
];

/**
 * Settings shell: a left sub-nav with URL-addressable sections.
 * HR sees every section; the technical admin sees Users & access and
 * Stand-ins. HR lands on the overview at `/settings`.
 */
export default function Settings() {
  const { me } = useSession();
  const { section } = useParams();
  const hr = me ? isHr(me) : false;
  const visible = SECTIONS.filter((s) => !s.hrOnly || hr);

  if (!section && !hr) return <Navigate to="/settings/users" replace />;
  const cur = visible.find((s) => s.slug === (section ?? 'overview'));
  if (!cur) {
    return <Navigate to={`/settings/${visible[0]!.slug}`} replace />;
  }

  return (
    <div className={hr ? 'settings-layout' : 'stack'}>
      {hr ? <nav className="settings-nav subnav" aria-label="Settings sections">
        {visible.map((s) => (
          <NavLink key={s.slug} to={s.slug === 'overview' ? '/settings' : `/settings/${s.slug}`} end>
            {s.label}
          </NavLink>
        ))}
      </nav> : null}
      <div className="settings-content">{cur.render()}</div>
    </div>
  );
}
