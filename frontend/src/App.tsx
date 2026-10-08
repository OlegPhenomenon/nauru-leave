import { Navigate, Route, Routes, useLocation } from 'react-router';
import Layout from './components/Layout';
import { Loading } from './components/ui';
import { useSession } from './lib/session';
import Approvals from './pages/Approvals';
import Balances from './pages/Balances';
import Explain from './pages/Explain';
import Help from './pages/Help';
import Landing from './pages/Landing';
import MyLeave from './pages/MyLeave';
import Operations from './pages/Operations';
import People from './pages/People';
import PersonDetail from './pages/PersonDetail';
import Reports from './pages/Reports';
import RequestDetail from './pages/RequestDetail';
import RequestNew from './pages/RequestNew';
import RequestPrint from './pages/RequestPrint';
import Settings from './pages/Settings';
import TeamCalendar from './pages/TeamCalendar';

function RequireAuth({ children }: { children: React.ReactElement }) {
  const { me, loading } = useSession();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!me) return <Navigate to="/" state={{ from: loc.pathname }} replace />;
  return children;
}

function NotFound() {
  return (
    <div className="panel">
      <h1>Page not found</h1>
      <p className="muted">This address does not match any screen.</p>
    </div>
  );
}

export default function App() {
  const { me } = useSession();
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Landing />} />
        <Route path="/my" element={<RequireAuth>{<MyLeave />}</RequireAuth>} />
        <Route
          path="/balances/:employeeId/explain"
          element={<RequireAuth>{<Explain />}</RequireAuth>}
        />
        <Route path="/requests/new" element={<RequireAuth>{<RequestNew />}</RequireAuth>} />
        <Route path="/requests/:id" element={<RequireAuth>{<RequestDetail />}</RequireAuth>} />
        <Route
          path="/requests/:id/print"
          element={<RequireAuth>{<RequestPrint />}</RequireAuth>}
        />
        <Route path="/approvals" element={<RequireAuth>{<Approvals />}</RequireAuth>} />
        <Route path="/calendar" element={<RequireAuth>{<TeamCalendar />}</RequireAuth>} />
        <Route path="/people" element={<RequireAuth>{<People />}</RequireAuth>} />
        <Route path="/people/:id" element={<RequireAuth>{<PersonDetail />}</RequireAuth>} />
        <Route path="/balances" element={<RequireAuth>{<Balances />}</RequireAuth>} />
        <Route path="/reports" element={<RequireAuth>{<Reports />}</RequireAuth>} />
        <Route path="/settings" element={<RequireAuth>{<Settings />}</RequireAuth>} />
        <Route path="/operations" element={<RequireAuth>{<Operations />}</RequireAuth>} />
        <Route path="/help" element={<RequireAuth>{<Help />}</RequireAuth>} />
        <Route path="*" element={me ? <NotFound /> : <Landing />} />
      </Route>
    </Routes>
  );
}
