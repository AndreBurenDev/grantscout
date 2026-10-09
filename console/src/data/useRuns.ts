import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiSend, ApiError, type Row } from '@/lib/api'
import { qk } from './keys'
import { toRun } from './converters'
import type { Run } from './types'
import { useLiveCollection } from './useLive'

/** Live list of pipeline runs, newest first. */
export function useLiveRuns() {
  return useLiveCollection(qk.runs.all, '/api/runs', toRun)
}

export function useRun(id: string) {
  return useQuery({
    queryKey: qk.runs.detail(id),
    queryFn: async (): Promise<Run | null> => {
      try {
        const row = await apiGet<Row>(`/api/runs/${encodeURIComponent(id)}`)
        return toRun(row.id, row.data)
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null
        throw e
      }
    },
  })
}

/** Queue a manual run on the service's single-worker queue. */
export function useTriggerRun() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (sourceId: string) => apiSend<{ id: string }>('POST', '/api/runs', { sourceId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.runs.all }),
  })
}
