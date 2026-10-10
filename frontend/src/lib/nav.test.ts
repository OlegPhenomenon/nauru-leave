import { describe, expect, it } from 'vitest';
import type { Me, Role } from '../api/types';
import { homeFor, myLeaveInBar, navFor } from './nav';

function me(role: Role): Me {
  return { roles: [{ role, scope_org_unit_id: null, scope_name: 'Whole service' }], is_manager: false, acting_for: [] } as unknown as Me;
}
describe('role navigation', () => {
  it.each(['hr', 'hr_medical'] as const)('gives %s a direct Settings link from Approvals', (role) => {
    expect(homeFor(me(role))).toBe('/approvals');
    expect(navFor(me(role)).at(-1)).toEqual({ to: '/settings', label: 'Settings' });
  });
  it('preserves the technical administrator navigation', () => {
    expect(homeFor(me('tech_admin'))).toBe('/system');
    expect(navFor(me('tech_admin')).map((n) => n.label)).toEqual(['System', 'Users & access', 'Stand-ins']);
  });
  it('preserves the auditor navigation', () => {
    expect(homeFor(me('auditor'))).toBe('/history');
    expect(navFor(me('auditor')).map((n) => n.label)).toEqual(['History', 'People', 'Balances', 'Reports']);
  });
  it.each(['hr', 'hr_medical', 'final_approver', 'adjustment_approver', 'auditor', 'tech_admin'] as const)('gives %s with an employee record one My leave link', (role) => {
    const user: Me = { ...me(role), employee: { id: 8, full_name: 'Employee', service_id: 'NPS-1001', org_unit: null } };
    expect(navFor(user).filter((item) => item.to === '/my')).toEqual([{ to: '/my', label: 'My leave' }]);
    expect(myLeaveInBar(user)).toBe(true);
  });
  it.each([false, true])('keeps My leave for employees (manager: %s)', (is_manager) => {
    const user: Me = { ...me('hr'), roles: [], is_manager, employee: { id: 8, full_name: 'Employee', service_id: 'NPS-1001', org_unit: null } };
    expect(navFor(user).filter((item) => item.to === '/my')).toEqual([{ to: '/my', label: 'My leave' }]);
    expect(myLeaveInBar(user)).toBe(true);
  });
  it.each(['hr', 'final_approver', 'auditor', 'tech_admin'] as const)('omits My leave for %s without an employee record', (role) => {
    expect(navFor(me(role)).some((item) => item.to === '/my')).toBe(false);
    expect(myLeaveInBar(me(role))).toBe(false);
  });
});
