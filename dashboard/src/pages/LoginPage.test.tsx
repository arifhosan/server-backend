import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { App } from '../App';
import { AuthProvider } from '../auth/AuthContext';

const ME = { id: 1, email: 'a@b.co', firstName: 'A', lastName: 'B', timezone: 'Europe/Berlin' };
const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });

/** Signed out until a login/register call succeeded. */
function mockBackend(opts: { loginStatus?: number } = {}) {
  let signedIn = false;
  const calls: string[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    calls.push(key);
    if (key === 'GET /api/auth/me') return signedIn ? reply(200, ME) : reply(401, { message: 'Unauthorized' });
    if (key === 'POST /api/auth/login') {
      if (opts.loginStatus && opts.loginStatus !== 200) return reply(opts.loginStatus, { message: 'Unauthorized' });
      signedIn = true;
      return reply(200, { access_token: 't', user: ME });
    }
    if (key === 'POST /api/auth/register') return reply(201, ME);
    if (key === 'GET /api/games/now') return reply(200, []);
    if (key === 'GET /api/games/overview')
      return reply(200, {
        nowPlaying: [], today: 0, thisWeek: 0, lastWeek: 0, last30Days: [], topGames30d: [],
        health: { connections: [], devices: [{ id: 1, name: 'PC', lastSeenAt: null }] },
      });
    return reply(404);
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

const Probe = () => <span data-testid="path">{useLocation().pathname}</span>;

const submitBtn = (form: 'Sign in' | 'Create account') =>
  within(screen.getByRole('form', { name: form })).getByRole('button', { name: form });

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
        <Probe />
      </AuthProvider>
    </MemoryRouter>,
  );

afterEach(() => vi.unstubAllGlobals());

describe('LoginPage', () => {
  it('redirects signed-out visitors to the sign-in page', async () => {
    mockBackend();
    renderAt('/library');
    expect(await screen.findByRole('form', { name: 'Sign in' })).toBeTruthy();
  });

  it('toggle buttons switch forms and expose state with aria-pressed', async () => {
    mockBackend();
    renderAt('/login');
    const user = userEvent.setup();
    await screen.findByRole('form', { name: 'Sign in' });
    await user.click(screen.getByRole('button', { name: 'Create account', pressed: false }));
    expect(screen.getByRole('form', { name: 'Create account' })).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Sign in' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Create account', pressed: true }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Sign in', pressed: false }));
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeTruthy();
  });

  it('shows the wrong-credentials message on 401', async () => {
    mockBackend({ loginStatus: 401 });
    renderAt('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'wrongwrong');
    await user.click(submitBtn('Sign in'));
    expect((await screen.findByRole('alert')).textContent).toBe('Email or password is wrong. Check both and try again.');
  });

  it('rejects a register password under 8 characters without submitting', async () => {
    const calls = mockBackend();
    renderAt('/login');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create account', pressed: false }));
    await user.type(screen.getByLabelText('First name'), 'A');
    await user.type(screen.getByLabelText('Last name'), 'B');
    await user.type(screen.getByLabelText('Email'), 'a@b.co');
    await user.type(screen.getByLabelText(/^Password/), 'short');
    await user.click(submitBtn('Create account'));
    expect(screen.getByLabelText(/^Password/).getAttribute('aria-invalid')).toBe('true');
    expect((await screen.findByRole('alert')).textContent).toBe('At least 8 characters');
    expect(calls).not.toContain('POST /api/auth/register');
  });

  it('logs in after register, then goes to next', async () => {
    const calls = mockBackend();
    renderAt('/login?next=/period');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create account', pressed: false }));
    await user.type(screen.getByLabelText('First name'), 'A');
    await user.type(screen.getByLabelText('Last name'), 'B');
    await user.type(screen.getByLabelText('Email'), 'a@b.co');
    await user.type(screen.getByLabelText(/^Password/), 'longenough');
    await user.click(submitBtn('Create account'));
    expect(await screen.findByRole('heading', { name: 'Period' })).toBeTruthy();
    expect(calls.indexOf('POST /api/auth/register')).toBeLessThan(calls.indexOf('POST /api/auth/login'));
  });

  it('navigates to next after login, or / without it', async () => {
    mockBackend();
    const first = renderAt('/login?next=/library');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'password1');
    await user.click(submitBtn('Sign in'));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Library' })).toBeTruthy());
    first.unmount();

    mockBackend();
    renderAt('/login');
    await user.type(await screen.findByLabelText('Email'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'password1');
    await user.click(submitBtn('Sign in'));
    await waitFor(() => expect(screen.getByText('Last 30 days')).toBeTruthy());
  });

  it.each(['//evil.example', '/\\evil.com'])('ignores off-site next %s', async (bad) => {
    mockBackend();
    renderAt(`/login?next=${encodeURIComponent(bad)}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'a@b.co');
    await user.type(screen.getByLabelText('Password'), 'password1');
    await user.click(submitBtn('Sign in'));
    expect(await screen.findByText('Last 30 days')).toBeTruthy();
    expect(screen.getByTestId('path').textContent).toBe('/');
  });

  it('shows required messages for empty register fields without submitting', async () => {
    const calls = mockBackend();
    renderAt('/login');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create account', pressed: false }));
    await user.click(submitBtn('Create account'));
    expect(screen.getByText('Enter your first name.')).toBeTruthy();
    expect(screen.getByText('Enter your last name.')).toBeTruthy();
    expect(screen.getByText('Enter your email address.')).toBeTruthy();
    expect(calls).not.toContain('POST /api/auth/register');
  });

  it('after register succeeds but login fails, shows sign-in with a notice', async () => {
    const calls = mockBackend({ loginStatus: 500 });
    renderAt('/login');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create account', pressed: false }));
    await user.type(screen.getByLabelText('First name'), 'A');
    await user.type(screen.getByLabelText('Last name'), 'B');
    await user.type(screen.getByLabelText('Email'), 'a@b.co');
    await user.type(screen.getByLabelText(/^Password/), 'longenough');
    await user.click(submitBtn('Create account'));
    expect((await screen.findByRole('status')).textContent).toBe('Account created. Sign in to continue.');
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeTruthy();
    expect(calls).toContain('POST /api/auth/register');
  });

  it('shows a spinner, not the form, while the session check runs', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderAt('/login');
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
  });
});
