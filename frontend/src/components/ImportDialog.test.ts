import { describe, expect, it } from 'vitest';
import { templateFor } from './ImportDialog';
import type { EmployeeListItem, LeaveType } from '../api/types';

const ctx = {
  units: [], schedules: [], today: '2026-10-08',
  people: [{ service_id: 'NPS-1004' } as EmployeeListItem],
  types: [{ name: 'Annual leave', code: 'ANNUAL', uses_balance: true } as LeaveType],
};

describe('plain import templates', () => {
  it('uses days, the leave type name and a half-day example', () => {
    expect(templateFor('opening_balances', ctx).csv).toBe(
      'staff_number,leave_type,year,days,basis\nNPS-1004,Annual leave,2026,12.5,Opening balance sheet',
    );
  });
  it('uses the staff number alias for people', () => {
    expect(templateFor('employees', ctx).csv.split('\n')[0]).toBe(
      'staff_number,full_name,email,start_date,org_unit,schedule,manager_service_id',
    );
  });
  it('uses the staff number alias and existing type code for past leave', () => {
    expect(templateFor('historical_leave', ctx).csv).toBe(
      'staff_number,leave_type,start_date,end_date\nNPS-1004,ANNUAL,2026-03-02,2026-03-06',
    );
  });
});
