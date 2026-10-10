import { post } from '../../api/client';
import type { EmployeeDetail } from '../../api/types';
import type { AffectedRequest } from './dialogs';

export interface PersonChanges {
  unitId: number;
  managerId: number;
  scheduleId: number;
  from: string;
  reassign: boolean;
}

/** Save only changed fields; stop on failure and report each completed operation. */
export async function savePersonChanges(
  employee: EmployeeDetail,
  changes: PersonChanges,
  onProgress: (operation: 'schedule' | 'transfer', affected: AffectedRequest[]) => void,
) {
  if (changes.scheduleId !== (employee.schedule?.id ?? 0)) {
    const result = await post<{ affected_future_requests?: AffectedRequest[] }>(`/employees/${employee.id}/schedule`, {
      schedule_id: changes.scheduleId,
      valid_from: changes.from,
      expected_version: employee.version,
    });
    onProgress('schedule', result.affected_future_requests ?? []);
  }
  if (changes.unitId !== (employee.org_unit?.id ?? 0) || changes.managerId !== (employee.manager?.id ?? 0)) {
    await post(`/employees/${employee.id}/transfer`, {
      org_unit_id: changes.unitId,
      manager_employee_id: changes.managerId || null,
      valid_from: changes.from,
      reassign_open_steps: changes.reassign,
    });
    onProgress('transfer', []);
  }
}
