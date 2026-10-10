// Role-aware navigation: home page, primary nav bar and
// badge counts. Single source of truth so the header, the mobile
// sheet and post-login landing all agree.

import { api, unwrapList } from '../api/client';
import type { Adjustment, ApprovalsResp, Me, Role } from '../api/types';
import { roleLabel } from './format';

export interface NavItem {
  to: string;
  label: string;
  /** badge count, shown only when > 0 */
  count?: number | undefined;
}

export interface NavCounts {
  approvals: number;
  corrections: number;
}

const hasRole = (me: Me, ...roles: Role[]) => me.roles.some((r) => roles.includes(r.role));

export const isHr = (me: Me) => hasRole(me, 'hr', 'hr_medical');
export const isTechAdmin = (me: Me) => hasRole(me, 'tech_admin');
export const isAuditor = (me: Me) => hasRole(me, 'auditor');
export const isFinalApprover = (me: Me) => hasRole(me, 'final_approver');
export const decidesApprovals = (me: Me) =>
  isHr(me) || isFinalApprover(me) || me.is_manager || me.acting_for.length > 0;

/**
 * Where a persona lands. Role priority: staff roles beat manager, which
 * beats plain employee. Managers land on Approvals only when the queue
 * has work for them.
 */
export function homeFor(me: Me, counts?: { approvals?: number | undefined } | undefined): string {
  if (isHr(me)) return '/approvals';
  if (isTechAdmin(me)) return '/system';
  if (isAuditor(me)) return '/history';
  if (isFinalApprover(me)) return '/approvals';
  if (me.is_manager || me.acting_for.length > 0) {
    return counts?.approvals ? '/approvals' : '/my';
  }
  return '/my';
}

/** Primary bar items for each role. */
export function navFor(me: Me, counts?: NavCounts): NavItem[] {
  const approvals: NavItem = { to: '/approvals', label: 'Approvals', count: counts?.approvals };
  if (isHr(me)) {
    return [
      approvals,
      { to: '/people', label: 'People' },
      { to: '/balances', label: 'Balances', count: counts?.corrections },
      { to: '/calendar', label: 'Calendar' },
      { to: '/reports', label: 'Reports' },
      { to: '/settings', label: 'Settings' },
    ];
  }
  if (isTechAdmin(me)) {
    return [
      { to: '/system', label: 'System' },
      { to: '/settings/users', label: 'Users & access' },
      { to: '/settings/delegations', label: 'Stand-ins' },
    ];
  }
  if (isAuditor(me)) {
    return [
      { to: '/history', label: 'History' },
      { to: '/people', label: 'People' },
      { to: '/balances', label: 'Balances' },
      { to: '/reports', label: 'Reports' },
    ];
  }
  if (isFinalApprover(me)) {
    return [
      approvals,
      { to: '/calendar', label: 'Calendar' },
      { to: '/reports', label: 'Reports' },
      { to: '/my', label: 'My leave' },
    ];
  }
  if (me.is_manager || me.acting_for.length > 0) {
    return [
      approvals,
      { to: '/calendar', label: 'Calendar' },
      { to: '/my', label: 'My leave' },
    ];
  }
  return [
    { to: '/my', label: 'My leave' },
    { to: '/calendar', label: 'Calendar' },
  ];
}

/** True when "My leave" is already a primary bar item for this user. */
export function myLeaveInBar(me: Me): boolean {
  return !isHr(me) && !isTechAdmin(me) && !isAuditor(me);
}

/**
 * The (role) shown next to the name in the demo strip, e.g. "HR officer".
 * Falls back to Manager / Employee for people with no system role.
 */
export function personRoleLabel(me: Me): string {
  if (isHr(me)) return roleLabel('hr');
  if (isTechAdmin(me)) return roleLabel('tech_admin');
  if (isAuditor(me)) return roleLabel('auditor');
  if (isFinalApprover(me)) return roleLabel('final_approver');
  if (hasRole(me, 'adjustment_approver')) return roleLabel('adjustment_approver');
  if (me.is_manager || me.acting_for.length > 0) return roleLabel('manager');
  return roleLabel('employee');
}

/**
 * Badge counts. Approvals = items waiting for me in /api/approvals.
 * Corrections = proposed adjustments waiting for a second approver
 * other than me (only fetched for adjustment_approver).
 * Failures yield zeros — the badge is a hint, not a gate.
 */
export async function fetchNavCounts(me: Me): Promise<NavCounts> {
  const counts: NavCounts = { approvals: 0, corrections: 0 };
  const jobs: Promise<void>[] = [];
  if (decidesApprovals(me)) {
    jobs.push(
      api<ApprovalsResp>('/approvals')
        .then((d) => {
          counts.approvals = d.items.filter(it => it.status !== 'needs_information').length;
        })
        .catch(() => {}),
    );
  }
  if (hasRole(me, 'adjustment_approver')) {
    jobs.push(
      api<unknown>('/adjustments', { query: { status: 'proposed' } })
        .then((d) => {
          counts.corrections = unwrapList<Adjustment>(d).filter(
            (a) => a.proposed_by.id !== me.user.id,
          ).length;
        })
        .catch(() => {}),
    );
  }
  await Promise.all(jobs);
  return counts;
}
