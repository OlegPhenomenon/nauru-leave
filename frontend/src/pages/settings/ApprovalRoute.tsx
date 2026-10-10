import { Link } from 'react-router';
import type { UserListItem } from '../../api/types';
import { EmptyState, ErrBox, Loading, PageHeader } from '../../components/ui';
import { readAll } from './data';
import { useApi } from '../../lib/useApi';
import { userRoleLabel } from './shared';

function whoHas(users: UserListItem[] | null, role: string): string[] {
  return (users ?? [])
    .filter((u) => u.active)
    .flatMap((u) =>
      u.roles
        .filter((r) => r.role === role)
        .map((r) =>
          r.scope_name && r.scope_name !== 'Whole service'
            ? `${u.display_name} (${r.scope_name})`
            : u.display_name,
        ),
    );
}

/**
 * Read-only explanation of who touches a request, in order.
 * Changes happen where the people live — this page only points there.
 */
export default function ApprovalRoute() {
  const users = useApi(() => readAll<UserListItem>('/users'), []);

  if (users.loading) return <Loading />;
  if (users.error) return <ErrBox error={users.error} />;

  const hrNames = [...new Set([...whoHas(users.data, 'hr'), ...whoHas(users.data, 'hr_medical')])];
  const finalNames = whoHas(users.data, 'final_approver');
  const adjNames = whoHas(users.data, 'adjustment_approver');

  return (
    <>
      <PageHeader
        title="Approval route"
        subtitle="Who a leave request passes through, in order. This page is read-only."
      />
      <ol className="route-steps">
        <li>
          <div className="step-body">
            <div className="step-who">The person's manager recommends</div>
            <p className="muted small">
              Each person's manager is set on their record under{' '}
              <Link to="/people">People</Link>. Managers get approval rights from there — nothing to
              set up here.
            </p>
          </div>
        </li>
        <li>
          <div className="step-body">
            <div className="step-who">
              An {userRoleLabel('hr')} checks it
              {hrNames.length ? ` — ${hrNames.join(', ')}` : ''}
            </div>
            <p className="muted small">
              {!hrNames.length ? 'Nobody has this role yet. ' : ''}
              Change who does this under <Link to="/settings/users?role=hr">Users & access</Link>.
            </p>
          </div>
        </li>
        <li>
          <div className="step-body">
            <div className="step-who">
              The {userRoleLabel('final_approver').toLowerCase()} decides
              {finalNames.length ? ` — ${finalNames.join(', ')}` : ''}
            </div>
            <p className="muted small">
              {!finalNames.length ? 'Nobody has this role yet. ' : ''}
              Change who does this under{' '}
              <Link to="/settings/users?role=final_approver">Users & access</Link>.
            </p>
          </div>
        </li>
      </ol>
      <ul className="sentence-list">
        <li>
          <span>
            Corrections to balances need a {userRoleLabel('adjustment_approver').toLowerCase()}
            {adjNames.length ? ` — ${adjNames.join(', ')}` : ''}.
          </span>
        </li>
        <li>
          <span>
            When a decision-maker is away, a stand-in can act for them — see{' '}
            <Link to="/settings/delegations">Stand-ins</Link>.
          </span>
        </li>
      </ul>
      {!users.data?.length ? <EmptyState text="No users found." /> : null}
    </>
  );
}
