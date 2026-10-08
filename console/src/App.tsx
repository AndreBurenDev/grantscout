import { lazy, Suspense } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/auth/AuthProvider'
import { NoAccess } from '@/auth/NoAccess'
import { AppShell } from '@/app/AppShell'
import { NotFound } from '@/app/NotFound'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { ToastProvider } from '@/components/feedback/Toast'

// Route-level code splitting — each screen is its own chunk.
const Overview = lazy(() => import('@/screens/Overview').then((m) => ({ default: m.Overview })))
const PipelineRuns = lazy(() => import('@/screens/PipelineRuns').then((m) => ({ default: m.PipelineRuns })))
const RunDetail = lazy(() => import('@/screens/RunDetail').then((m) => ({ default: m.RunDetail })))
const Sources = lazy(() => import('@/screens/Sources').then((m) => ({ default: m.Sources })))
const Organizations = lazy(() => import('@/screens/Organizations').then((m) => ({ default: m.Organizations })))
const OrganizationDetail = lazy(() => import('@/screens/OrganizationDetail').then((m) => ({ default: m.OrganizationDetail })))
const Grants = lazy(() => import('@/screens/Grants').then((m) => ({ default: m.Grants })))
const ReviewQueue = lazy(() => import('@/screens/ReviewQueue').then((m) => ({ default: m.ReviewQueue })))
const ScoringResults = lazy(() => import('@/screens/ScoringResults').then((m) => ({ default: m.ScoringResults })))
const Settings = lazy(() => import('@/screens/Settings').then((m) => ({ default: m.Settings })))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
})

function Splash() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas">
      <div className="flex items-center gap-3 text-muted">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-hair-strong border-t-accent" />
        <span className="text-sm">Loading…</span>
      </div>
    </div>
  )
}

export function AuthGate() {
  const { user, loading, deniedStatus } = useAuth()

  if (loading) return <Splash />
  if (!user) return <NoAccess status={deniedStatus} />

  return (
    <Suspense fallback={<Splash />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Overview />} />
          <Route path="runs" element={<PipelineRuns />} />
          <Route path="runs/:id" element={<RunDetail />} />
          <Route path="sources" element={<Sources />} />
          <Route path="organizations" element={<Organizations />} />
          <Route path="organizations/:id" element={<OrganizationDetail />} />
          <Route path="grants" element={<Grants />} />
          <Route path="review" element={<ReviewQueue />} />
          <Route path="scoring" element={<ScoringResults />} />
          <Route path="settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <AuthProvider>
            <BrowserRouter
              future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
            >
              <AuthGate />
            </BrowserRouter>
          </AuthProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}
