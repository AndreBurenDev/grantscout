import { useQuery } from '@tanstack/react-query'
import { apiGet, type Row } from '@/lib/api'
import { qk } from './keys'
import { toRun } from './converters'
import type { Run } from './types'

export interface OverviewData {
  totalRuns: number
  activeSources: number
  pendingReview: number
  organizations: number
  recentRuns: Run[]
}

export function useOverview() {
  return useQuery({
    queryKey: qk.overview.all,
    queryFn: async (): Promise<OverviewData> => {
      const d = await apiGet<Omit<OverviewData, 'recentRuns'> & { recentRuns: Row[] }>('/api/overview')
      return {
        totalRuns: d.totalRuns,
        activeSources: d.activeSources,
        pendingReview: d.pendingReview,
        organizations: d.organizations,
        recentRuns: d.recentRuns.map((r) => toRun(r.id, r.data)),
      }
    },
  })
}
