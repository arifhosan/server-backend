import { renderHook, waitFor, act } from '@testing-library/react';
import { useApi } from './useApi';

afterEach(() => vi.unstubAllGlobals());

describe('useApi', () => {
  it('exposes data, then re-fetches on reload()', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ n: ++n }))));
    const { result } = renderHook(() => useApi<{ n: number }>('/games/now'));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.data).toEqual({ n: 2 }));
  });

  it('exposes error on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'boom' }), { status: 500 })));
    const { result } = renderHook(() => useApi('/games/now'));
    await waitFor(() => expect(result.current.error?.status).toBe(500));
    expect(result.current.error?.message).toBe('boom');
    expect(result.current.loading).toBe(false);
  });

  it('does not fetch when path is null', () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const { result } = renderHook(() => useApi(null));
    expect(result.current.loading).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});
