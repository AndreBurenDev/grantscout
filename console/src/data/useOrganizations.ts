import { useQuery } from '@tanstack/react-query'
import { apiGet, type Row } from '@/lib/api'
import { qk } from './keys'
import { toOrganization, toAccountScore, toSignalSummary } from './converters'
import type { Organization, AccountScore, SignalSummary } from './types'

export function useOrganizations() {
  return useQuery({
    queryKey: qk.organizations.all,
    queryFn: async (): Promise<Organization[]> =>
      (await apiGet<Row[]>('/api/organizations'))
        .map((r) => toOrganization(r.id, r.data))
        .sort((a, b) => (a.names[0] ?? '').localeCompare(b.names[0] ?? '')),
  })
}

export interface OrgDetail {
  org: Organization | null
  score: AccountScore | null
  signals: SignalSummary[]
}

export function useOrganizationDetail(id: string) {
  return useQuery({
    queryKey: qk.organizations.detail(id),
    queryFn: async (): Promise<OrgDetail> => {
      const d = await apiGet<{ org: Row | null; score: Row | null; signals: Row[] }>(
        `/api/organizations/${encodeURIComponent(id)}`,
      )
      return {
        org: d.org ? toOrganization(d.org.id, d.org.data) : null,
        score: d.score ? toAccountScore(d.score.id, d.score.data) : null,
        signals: d.signals.map((s) => toSignalSummary(s.id, s.data)),
      }
    },
  })
}
