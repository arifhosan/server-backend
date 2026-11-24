import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './auth/AuthContext';
import { AppShell } from './components/AppShell';
import { Spinner } from './components/Spinner';
import { LoginPage } from './pages/LoginPage';

/** Signed-out visitors go to /login?next=<where they were headed>. */
function RequireAuth() {
  const { user } = useAuth();
  const { pathname, search } = useLocation();
  if (user === undefined) return <Spinner />;
  if (user === null) return <Navigate to={`/login?next=${encodeURIComponent(pathname + search)}`} replace />;
  return <AppShell />;
}

// Placeholder until the page's own task lands.
const Page = ({ title }: { title: string }) => <h1>{title}</h1>;

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route index element={<Page title="Overview" />} />
        <Route path="library" element={<Page title="Library" />} />
        <Route path="games/:id" element={<Page title="Game" />} />
        <Route path="period" element={<Page title="Period" />} />
        <Route path="settings" element={<Page title="Devices & connections" />} />
        <Route path="*" element={<Page title="Not found" />} />
      </Route>
    </Routes>
  );
}
