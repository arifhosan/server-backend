import type { ReactNode } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { useAuth } from '../auth/AuthContext';
import { Logo } from './Logo';
import '../styles/shell.css';

const icon = (d: ReactNode) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    {d}
  </svg>
);

const NAV = [
  { to: '/', label: 'Overview', tab: 'Overview', icon: icon(<path d="M3 12l9-8 9 8M5 10v10h14V10" />) },
  { to: '/library', label: 'Library', tab: 'Library', icon: icon(<path d="M4 5h16M4 12h16M4 19h16" />) },
  {
    to: '/period',
    label: 'Period',
    tab: 'Period',
    icon: icon(
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M3 10h18M8 3v4M16 3v4" />
      </>,
    ),
  },
  {
    to: '/settings',
    label: 'Devices & connections',
    tab: 'Devices',
    icon: icon(
      <>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M8 20h8M12 16v4" />
      </>,
    ),
  },
];

const cls = (base: string) => ({ isActive }: { isActive: boolean }) => (isActive ? `${base} active` : base);

export function AppShell() {
  const { logout } = useAuth();
  return (
    <div className="shell">
      <header className="shell-header">
        <div className="shell-header-inner">
          <Link to="/" className="brand">
            <Logo />
            Playtime
          </Link>
          <nav aria-label="Main" className="nav-top">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.to === '/'} className={cls('navlink')}>
                {n.label}
              </NavLink>
            ))}
          </nav>
          <button type="button" className="btn" onClick={() => void logout()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="shell-main">
        <Outlet />
      </main>
      <nav aria-label="Tabs" className="nav-bottom">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/'} className={cls('tab')}>
            {n.icon}
            {n.tab}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
