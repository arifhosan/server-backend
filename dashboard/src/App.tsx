import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useAuth } from './auth/AuthContext';
import { AppShell } from './components/AppShell';
import { Spinner } from './components/Spinner';
import { GamePage } from './pages/GamePage';
import { LibraryPage } from './pages/LibraryPage';
import { LoginPage } from './pages/LoginPage';
import { OverviewPage } from './pages/OverviewPage';
import { PeriodPage } from './pages/PeriodPage';
import { SettingsPage } from './pages/SettingsPage';

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
        <Route index element={<OverviewPage />} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="games/:id" element={<GamePage />} />
        <Route path="period" element={<PeriodPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Page title="Not found" />} />
      </Route>
    </Routes>
  );
}
