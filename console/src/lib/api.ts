/**
 * Thin client for the GrantScout admin API (same origin as the Console).
 * Authentication is ambient: the tailnet proxy identifies the user, so there is no token to attach.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/** A stored document as the API returns it. */
export interface Row {
  id: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body?.error) message = body.error
    } catch {
      /* not JSON: keep the status text */
    }
    throw new ApiError(res.status, message)
  }
  return (await res.json()) as T
}

export async function apiGet<T>(path: string): Promise<T> {
  return parse<T>(await fetch(path, { headers: { Accept: 'application/json' } }))
}

export async function apiSend<T>(
  method: 'POST' | 'PUT' | 'PATCH',
  path: string,
  body: unknown,
): Promise<T> {
  return parse<T>(
    await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}
