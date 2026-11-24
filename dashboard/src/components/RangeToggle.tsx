import '../styles/game.css';

export interface RangeOption<T extends string> {
  id: T;
  label: string;
}

/** Segmented pressed-button group. */
export function RangeToggle<T extends string>({
  options,
  value,
  onChange,
  label = 'Range',
}: {
  options: RangeOption<T>[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div role="group" aria-label={label} className="range-group">
      {options.map((o) => (
        <button key={o.id} type="button" className="range-seg" aria-pressed={o.id === value} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
