import { describe, expect, it } from 'vitest';
import type { RequestDetail } from '../../api/types';
import { approvedActions } from './ApprovedActions';

function request(patch: Partial<RequestDetail> = {}): RequestDetail {
  return { kind: 'leave', status: 'approved', date_phase: 'upcoming', allowed_actions: ['amend', 'cancel', 'propose_actual_adjustment'], ...patch } as RequestDetail;
}
describe('approved leave shortcuts', () => {
  it('uses the same authorized actions for rows and the request page', () => {
    expect(approvedActions(request()).map((a) => a.action)).toEqual(['amend', 'cancel', 'actual-worked']);
  });
  it('does not expose actions missing from the server capabilities', () => {
    expect(approvedActions(request({ allowed_actions: ['print'] }))).toEqual([]);
  });
  it('leaves past leave to the actual-worked correction flow', () => {
    expect(approvedActions(request({ date_phase: 'period_ended' })).map((a) => a.action)).toEqual(['actual-worked']);
  });
  it('does not offer approved-leave actions on pending requests or amendments', () => {
    expect(approvedActions(request({ status: 'submitted' }))).toEqual([]);
    expect(approvedActions(request({ kind: 'amendment' }))).toEqual([]);
  });
});
