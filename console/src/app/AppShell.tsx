import { useEffect, useState } from 'react'
import { Outlet, Link, useLocation } from 'react-router-dom'
import { useAuth } from '@/auth/AuthProvider'
import { cn } from '@/lib/cn'
import {
  BarChart3,
  Settings,
  Database,
  Play,
  CheckSquare,
  Zap,
  Building2,
  Banknote,
  Menu,
  X,
} from 'lucide-react'

const navItems = [
  { label: 'Overview', path: '/', icon: BarChart3 },
  { label: 'Pipeline Runs', path: '/runs', icon: Play },
  { label: 'Sources', path: '/sources', icon: Database },
  { label: 'Organizations', path: '/organizations', icon: Building2 },
  { label: 'Grants', path: '/grants', icon: Banknote },
  { label: 'Review Queue', path: '/review', icon: CheckSquare },
  { label: 'Scoring Results', path: '/scoring', icon: Zap },
  { label: 'Settings', path: '/settings', icon: Settings },
]

export function AppShell() {
  const { user } = useAuth()
  const location = useLocation()
  const [drawerOpen, setDrawerOpen] = useState(false)

  // Close the mobile drawer whenever the route changes.
  useEffect(() => {
    setDrawerOpen(false)
  }, [location.pathname])

  const isActive = (path: string) =>
    path === '/'
      ? location.pathname === '/'
      : location.pathname.startsWith(path)

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-hair p-4">
        <div>
          <h1 className="text-lg font-bold text-accent">GrantScout</h1>
          <p className="text-xs text-faint">Admin Console</p>
        </div>
        <button
          onClick={() => setDrawerOpen(false)}
          aria-label="Close menu"
          className="text-faint hover:text-fg md:hidden"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto p-4" aria-label="Main">
        <ul className="space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon
            const active = isActive(item.path)
            return (
              <li key={item.path}>
                <Link
                  to={item.path}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 rounded px-3 py-2 text-sm transition-colors',
                    active
                      ? 'bg-accent-soft font-medium text-accent'
                      : 'text-muted hover:bg-hair',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>

      <div className="border-t border-hair p-4">
        <div>
          <p className="text-xs font-medium text-muted">Signed in via tailnet as</p>
          <p className="truncate text-sm font-medium text-fg">{user?.email}</p>
        </div>
      </div>
    </div>
  )

  return (
    <div className="flex h-screen bg-canvas">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 border-r border-hair bg-sidebar md:block">
        {sidebar}
      </aside>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setDrawerOpen(false)}
            aria-hidden="true"
          />
          <aside className="absolute left-0 top-0 h-full w-64 border-r border-hair bg-sidebar">
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <header className="flex items-center gap-3 border-b border-hair bg-sidebar px-4 py-3 md:hidden">
          <button
            onClick={() => setDrawerOpen(true)}
            aria-label="Open menu"
            className="text-muted hover:text-fg"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-sm font-bold text-accent">GrantScout</span>
        </header>

        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
