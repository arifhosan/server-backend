import { render, screen } from '@testing-library/react';
import { AuthProvider } from '../auth/AuthContext';
import { PsnCard } from './PsnCard';

describe('PsnCard', () => {
  it('external links open in a new tab safely', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })));
    render(<AuthProvider><PsnCard conn={undefined} onChange={() => {}} /></AuthProvider>);
    for (const name of ['playstation.com', "Sony's token page"]) {
      const a = screen.getByRole('link', { name });
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer');
    }
    vi.unstubAllGlobals();
  });
});

import userEvent from '@testing-library/user-event';
import { extractNpsso } from './PsnCard';

const T = 'a'.repeat(32) + 'B1'.repeat(16);
describe('extractNpsso', () => {
  it('handles JSON, quoted, bare and padded input', () => {
    expect(extractNpsso(`{"npsso": "${T}"}`)).toBe(T);
    expect(extractNpsso(`  {\n"npsso":"${T}"\n} `)).toBe(T);
    expect(extractNpsso(`"${T}"`)).toBe(T);
    expect(extractNpsso(`  ${T}\n`)).toBe(T);
  });
});

describe('PsnCard token check', () => {
  it('shows the hint and does not send a malformed token; sends the extracted one otherwise', async () => {
    const fn = vi.fn(async (url: string, init?: RequestInit) => new Response(init ? url : null, { status: 401 }));
    vi.stubGlobal('fetch', fn);
    render(<AuthProvider><PsnCard conn={undefined} onChange={() => {}} /></AuthProvider>);
    const input = screen.getByLabelText(/NPSSO token/);
    await userEvent.type(input, 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Connect PlayStation' }));
    expect(screen.getByRole('alert').textContent).toContain("doesn't look like an NPSSO token");
    expect(fn.mock.calls.some((c) => String(c[0]).includes('connections/psn'))).toBe(false);
    await userEvent.clear(input);
    await userEvent.click(input);
    await userEvent.paste(`{"npsso":"${T}"}`);
    await userEvent.click(screen.getByRole('button', { name: 'Connect PlayStation' }));
    const put = fn.mock.calls.find((c) => String(c[0]).includes('connections/psn'));
    expect(String((put![1] as RequestInit).body)).toContain(T);
    vi.unstubAllGlobals();
  });
});
