import type { ReactNode } from 'react';
import type { Dir } from '../lib/sort';
import '../styles/library.css';

export interface Column<T> {
  key: string;
  label: string;
  numeric?: boolean;
  /** Platforms-style columns are not sortable. */
  sortable?: boolean;
  cell: (row: T) => ReactNode;
}

export function SortableTable<T>({
  columns,
  rows,
  rowKey,
  sortKey,
  dir,
  onSort,
  label,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  sortKey: string;
  dir: Dir;
  onSort: (key: string) => void;
  label: string;
}) {
  return (
    <section aria-label={label} className="table-card">
      <table>
        <thead>
          <tr>
            {columns.map((c) => {
              const on = c.sortable && c.key === sortKey;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={c.numeric ? 'num' : undefined}
                  aria-sort={c.sortable ? (on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none') : undefined}
                >
                  {c.sortable ? (
                    <button type="button" className="th" onClick={() => onSort(c.key)}>
                      {c.label}
                      <span aria-hidden="true" className="arrow">
                        {on ? (dir === 'asc' ? '▲' : '▼') : ''}
                      </span>
                    </button>
                  ) : (
                    <span className="th-static">{c.label}</span>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)}>
              {columns.map((c) => (
                <td key={c.key} className={c.numeric ? 'num' : undefined}>
                  {c.cell(r)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
