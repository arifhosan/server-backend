import { api, ApiError, json, setOnUnauthorized } from './client';

const reply = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status });

afterEach(() => {
  vi.unstubAllGlobals();
  setOnUnauthorized(null);
});

describe('api', () => {
  it('prefixes /api, sends same-origin credentials and JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply(200, { ok: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await api('/games/now', json('POST', { a: 1 }));
    expect(out).toEqual({ ok: 1 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/games/now');
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBe('{"a":1}');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
  });

  it('calls onUnauthorized once on a 401 and throws ApiError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { message: 'nope' })));
    const cb = vi.fn();
    setOnUnauthorized(cb);
    await expect(api('/games/overview')).rejects.toMatchObject({ status: 401, message: 'nope' });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('401 on /auth/login throws ApiError(401) without onUnauthorized', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reply(401, { message: 'bad' })));
    const cb = vi.fn();
    setOnUnauthorized(cb);
    const err = await api('/auth/login', json('POST', {})).catch((e: ApiError) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(cb).not.toHaveBeenCalled();
  });

  it('joins validation message arrays and tolerates empty bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(reply(400, { message: ['a', 'b'] })).mockResolvedValueOnce(reply(204)));
    await expect(api('/x')).rejects.toMatchObject({ status: 400, message: 'a, b' });
    await expect(api('/x')).resolves.toBeUndefined();
  });
});
