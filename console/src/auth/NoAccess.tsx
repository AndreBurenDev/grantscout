import { ShieldAlert } from 'lucide-react'

/** Shown instead of the Console when the API did not recognise the caller. */
export function NoAccess({ status }: { status: number | null }) {
  const detail =
    status === 403
      ? 'Your tailnet login is not on the GrantScout allowlist. Ask the operator to add it to CONSOLE_ALLOWLIST.'
      : status === 401
        ? 'Open the Console through its tailnet address. Direct connections carry no identity and are refused.'
        : 'The GrantScout service did not answer. It may be restarting.'

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas">
      <div className="w-full max-w-md rounded-lg border border-hair bg-panel p-8 shadow-sm">
        <div className="mb-3 flex items-center gap-3">
          <ShieldAlert className="h-5 w-5 text-warning" />
          <h1 className="text-xl font-bold text-fg">No access</h1>
        </div>
        <p className="text-sm text-muted">{detail}</p>
      </div>
    </div>
  )
}
