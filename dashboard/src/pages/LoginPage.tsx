import { useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { ApiError } from '../api/client';
import { AccountCreatedError, useAuth } from '../auth/AuthContext';
import { Spinner } from '../components/Spinner';
import { Logo } from '../components/Logo';
import '../styles/login.css';

type Field = 'firstName' | 'lastName' | 'email' | 'password';

const WRONG = 'Email or password is wrong. Check both and try again.';

/** Only same-site paths; anything else falls back to the overview. */
const safeNext = (n: string | null) => (n && /^\/(?![/\\])/.test(n) ? n : '/');

export function LoginPage() {
  const { user, login, register } = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [errs, setErrs] = useState<Partial<Record<Field, string>>>({});
  const [busy, setBusy] = useState(false);

  if (user === undefined) return <Spinner />;
  if (user) return <Navigate to={next} replace />;

  const switchTo = (m: 'signin' | 'register') => {
    setMode(m);
    setError('');
    setNotice('');
    setErrs({});
  };

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const get = (k: string) => String(f.get(k) ?? '');
    setError('');
    setNotice('');
    if (mode === 'register') {
      const found: Partial<Record<Field, string>> = {};
      if (!get('firstName').trim()) found.firstName = 'Enter your first name.';
      if (!get('lastName').trim()) found.lastName = 'Enter your last name.';
      if (!get('email').trim()) found.email = 'Enter your email address.';
      else if (!/^\S+@\S+$/.test(get('email').trim())) found.email = 'Enter a valid email address.';
      if (get('password').length < 8) found.password = 'At least 8 characters';
      setErrs(found);
      if (Object.keys(found).length) return;
    }
    setBusy(true);
    try {
      if (mode === 'signin') await login(get('email'), get('password'));
      else
        await register({
          firstName: get('firstName'),
          lastName: get('lastName'),
          email: get('email'),
          password: get('password'),
        });
      // success: user is set, the redirect above runs on re-render
    } catch (err) {
      if (err instanceof AccountCreatedError) {
        setMode('signin');
        setNotice(err.message);
      } else if (mode === 'signin' && err instanceof ApiError && err.status === 401) setError(WRONG);
      else setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  }

  const isSignIn = mode === 'signin';
  const pwError = !!errs.password;
  const bad = (f: Field) => ({ 'aria-invalid': !!errs[f], 'aria-describedby': errs[f] ? `${f}-err` : undefined });
  return (
    <div className="login">
      <div className="login-col">
        <div className="login-hero">
          <Logo size={44} />
          <h1>Playtime</h1>
          <p>Your playtime from PC, Steam and PlayStation in one place.</p>
        </div>

        <section className="login-card">
          <div role="group" aria-label="Account" className="tabs">
            <button type="button" className="tab-btn" aria-pressed={isSignIn} onClick={() => switchTo('signin')}>
              Sign in
            </button>
            <button type="button" className="tab-btn" aria-pressed={!isSignIn} onClick={() => switchTo('register')}>
              Create account
            </button>
          </div>

          {isSignIn ? (
            <form className="form" aria-label="Sign in" onSubmit={submit}>
              <label className="label">
                Email
                <input className="field" name="email" type="email" autoComplete="email" placeholder="you@example.com" required />
              </label>
              <label className="label">
                Password
                <input className="field" name="password" type="password" autoComplete="current-password" required />
              </label>
              {notice && (
                <div role="status" className="notice">
                  {notice}
                </div>
              )}
              {error && (
                <div role="alert" className="alert">
                  {error}
                </div>
              )}
              <button className="primary" type="submit" disabled={busy}>
                Sign in
              </button>
              <p className="note center">You stay signed in on this device for 30 days.</p>
            </form>
          ) : (
            <form className="form" aria-label="Create account" onSubmit={submit} noValidate>
              <div className="form-grid">
                <label className="label">
                  First name
                  <input className="field" name="firstName" type="text" autoComplete="given-name" {...bad('firstName')} />
                  <FieldErr id="firstName-err" msg={errs.firstName} />
                </label>
                <label className="label">
                  Last name
                  <input className="field" name="lastName" type="text" autoComplete="family-name" {...bad('lastName')} />
                  <FieldErr id="lastName-err" msg={errs.lastName} />
                </label>
              </div>
              <label className="label">
                Email
                <input className="field" name="email" type="email" autoComplete="email" placeholder="you@example.com" {...bad('email')} />
                <FieldErr id="email-err" msg={errs.email} />
              </label>
              <label className="label">
                Password
                <input
                  className="field"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  maxLength={72}
                  aria-describedby="pw-hint"
                  aria-invalid={pwError}
                />
                <span id="pw-hint" className={pwError ? 'hint error' : 'hint'} role={pwError ? 'alert' : undefined}>
                  At least 8 characters
                </span>
              </label>
              {error && (
                <div role="alert" className="alert">
                  {error}
                </div>
              )}
              <button className="primary" type="submit" disabled={busy}>
                Create account
              </button>
              <p className="note">Steam and PlayStation details you add later are stored encrypted on this server.</p>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}

function FieldErr({ id, msg }: { id: string; msg?: string }) {
  return msg ? (
    <span id={id} className="field-err" role="alert">
      {msg}
    </span>
  ) : null;
}
