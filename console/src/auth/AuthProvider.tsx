import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { apiGet, ApiError } from '@/lib/api'
import type { User } from '@/types'

interface AuthContextType {
  user: User | null
  loading: boolean
  /** Why there is no user: 401 = not reached through the tailnet, 403 = not on the allowlist. */
  deniedStatus: number | null
}

const AuthContext = createContext<AuthContextType | undefined>(undefined)

/**
 * Identity comes from the tailnet proxy in front of the Console, so there is nothing to sign in to:
 * ask the API who we are and either get an email back or learn why not.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [deniedStatus, setDeniedStatus] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    apiGet<{ email: string }>('/api/me')
      .then((me) => {
        if (!cancelled) setUser({ id: me.email, email: me.email })
      })
      .catch((e) => {
        if (!cancelled) setDeniedStatus(e instanceof ApiError ? e.status : 0)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <AuthContext.Provider value={{ user, loading, deniedStatus }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
