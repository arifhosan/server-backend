import { render, screen } from '@testing-library/react';
import type { DayPoint } from '../api/types';
import { DayBarChart } from './DayBarChart';

const day = (date: string, seconds: number, unknownSources: DayPoint['unknownSources'] = []): DayPoint => ({
  date,
  seconds,
  estimated: false,
  unknownSources,
});

describe('DayBarChart', () => {
  it('marks unknown and future days and labels the total and best day', () => {
    const { container } = render(
      <DayBarChart
        futureAfter="2026-11-24"
        days={[day('2026-11-23', 3600), day('2026-11-24', 7200), day('2026-11-25', 0, ['psn']), day('2026-11-26', 0)]}
      />,
    );
    const img = screen.getByRole('img');
    expect(img.getAttribute('aria-label')).toBe('Daily playtime Nov 23 to Nov 26. Total 3h 00m. Highest day: Nov 24 with 2h 00m.');
    const titles = [...container.querySelectorAll('.chart-col')].map((c) => c.getAttribute('title'));
    expect(titles[0]).toBe('Mon, Nov 23: 1h 00m');
    expect(titles[2]).toBe('Wed, Nov 25: not yet'); // future wins over unknown
    expect(container.querySelectorAll('.bar').length).toBe(2);
    expect(container.querySelectorAll('.bar-unknown').length).toBe(0);
  });

  it('shows a hatched bar and "unknown" tooltip for past unknown days', () => {
    const { container } = render(<DayBarChart days={[day('2026-11-03', 0, ['steam'])]} />);
    expect(container.querySelectorAll('.bar-unknown').length).toBe(1);
    expect(container.querySelector('.chart-col')?.getAttribute('title')).toContain('unknown');
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('1 day unknown');
  });
});
