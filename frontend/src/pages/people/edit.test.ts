import { beforeEach, describe, expect, it, vi } from 'vitest';
import { post } from '../../api/client';
import type { EmployeeDetail } from '../../api/types';
import { savePersonChanges, type PersonChanges } from './edit';

// Only the external HTTP boundary is simulated; selection and sequencing run unchanged.
vi.mock('../../api/client', () => ({ post: vi.fn() }));
const employee = { id: 8, version: 7, org_unit: { id: 2 }, manager: { id: 3 }, schedule: { id: 4 } } as EmployeeDetail;
const unchanged: PersonChanges = { unitId: 2, managerId: 3, scheduleId: 4, from: '2026-11-01', reassign: true };
const http = vi.mocked(post);
beforeEach(() => { http.mockReset(); });

describe('combined person changes', () => {
  it('writes nothing when only the From date changed', async () => {
    await savePersonChanges(employee, unchanged, vi.fn());
    expect(http).not.toHaveBeenCalled();
  });
  it('clears the manager without writing a schedule history row', async () => {
    http.mockResolvedValue({});
    await savePersonChanges(employee, { ...unchanged, managerId: 0 }, vi.fn());
    expect(http).toHaveBeenCalledExactlyOnceWith('/employees/8/transfer', {
      org_unit_id: 2, manager_employee_id: null, valid_from: '2026-11-01', reassign_open_steps: true,
    });
  });
  it('changes only the work pattern using the loaded employee version', async () => {
    http.mockResolvedValue({ affected_future_requests: [{ id: 12, number: 'NLD-2026-00012' }] });
    const progress = vi.fn();
    await savePersonChanges(employee, { ...unchanged, scheduleId: 5 }, progress);
    expect(http).toHaveBeenCalledExactlyOnceWith('/employees/8/schedule', {
      schedule_id: 5, valid_from: '2026-11-01', expected_version: 7,
    });
    expect(progress).toHaveBeenCalledWith('schedule', [{ id: 12, number: 'NLD-2026-00012' }]);
  });
  it('saves the pattern before transferring out of the current HR scope', async () => {
    http.mockResolvedValue({});
    const progress = vi.fn();
    await savePersonChanges(employee, { ...unchanged, scheduleId: 5, unitId: 9 }, progress);
    expect(http.mock.calls.map(([path]) => path)).toEqual(['/employees/8/schedule', '/employees/8/transfer']);
    expect(progress.mock.calls.map(([operation]) => operation)).toEqual(['schedule', 'transfer']);
  });
  it('stops before transfer if the schedule version is stale', async () => {
    http.mockRejectedValue(new Error('stale_version'));
    const progress = vi.fn();
    await expect(savePersonChanges(employee, { ...unchanged, scheduleId: 5, unitId: 9 }, progress)).rejects.toThrow('stale_version');
    expect(http).toHaveBeenCalledTimes(1);
    expect(progress).not.toHaveBeenCalled();
  });
  it('reports the completed pattern change when transfer fails', async () => {
    http.mockResolvedValueOnce({ affected_future_requests: [{ id: 12, number: 'NLD-2026-00012' }] }).mockRejectedValueOnce(new Error('forbidden'));
    const progress = vi.fn();
    await expect(savePersonChanges(employee, { ...unchanged, scheduleId: 5, unitId: 9 }, progress)).rejects.toThrow('forbidden');
    expect(progress).toHaveBeenCalledExactlyOnceWith('schedule', [{ id: 12, number: 'NLD-2026-00012' }]);
  });
});
