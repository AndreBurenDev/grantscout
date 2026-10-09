import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiGet, apiSend, ApiError } from './api'

afterEach(() => vi.unstubAllGlobals())

function stubFetch(status: number, body: unknown, statusText = '') {
  const fetchMock = vi.fn(async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, statusText }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('api client', () => {
  it('returns parsed JSON on success', async () => {
    stubFetch(200, { email: 'a@b.c' })
    expect(await apiGet<{ email: string }>('/api/me')).toEqual({ email: 'a@b.c' })
  })

  it('throws an ApiError carrying the status and the server message', async () => {
    stubFetch(403, { error: 'not allowed' })
    const err = (await apiGet('/api/me').catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(403)
    expect(err.message).toBe('not allowed')
  })

  it('falls back to the status line when the error body is not JSON', async () => {
    stubFetch(502, '<html>bad gateway</html>', 'Bad Gateway')
    const err = (await apiGet('/api/me').catch((e) => e)) as ApiError
    expect(err.status).toBe(502)
    expect(err.message).toBe('502 Bad Gateway')
  })

  it('sends writes as JSON, which the CSRF guard requires', async () => {
    const fetchMock = stubFetch(200, { ok: true })
    await apiSend('PATCH', '/api/sources/anbi-nl', { enabled: false })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/sources/anbi-nl')
    expect(init.method).toBe('PATCH')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(init.body).toBe('{"enabled":false}')
  })
})
