import type { ReactNode } from 'react';
import '../styles/overview.css';

export function StatCard({ label, value, children }: { label: string; value?: string; children?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      {value !== undefined && <div className="stat-value">{value}</div>}
      {children}
    </div>
  );
}
