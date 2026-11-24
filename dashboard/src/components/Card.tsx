import type { ReactNode } from 'react';
import '../styles/components.css';

export function Card({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <section className="card" aria-label={label}>
      {children}
    </section>
  );
}
