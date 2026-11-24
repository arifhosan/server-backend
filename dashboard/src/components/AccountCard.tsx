import { useAuth } from '../auth/AuthContext';

export function AccountCard() {
  const { user, logout } = useAuth();
  return (
    <section className="card set-card" aria-label="Account">
      <div className="strong big">Account</div>
      <div className="kv">
        <span>Time zone</span>
        <span>{user?.timezone}</span>
      </div>
      <div className="kv">
        <span>Email</span>
        <span>{user?.email}</span>
      </div>
      <div>
        <button className="btn ghost" type="button" onClick={() => void logout()}>
          Sign out
        </button>
      </div>
    </section>
  );
}
