import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiSend, type Row } from '@/lib/api'
import { qk } from './keys'
import { toSource } from './converters'
import type { Source } from './types'

export function useSources() {
  return useQuery({
    queryKey: qk.sources.all,
    queryFn: async (): Promise<Source[]> =>
      (await apiGet<Row[]>('/api/sources'))
        .map((r) => toSource(r.id, r.data))
        .sort((a, b) => a.name.localeCompare(b.name)),
  })
}

export function useToggleSource() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      apiSend('PATCH', `/api/sources/${encodeURIComponent(id)}`, { enabled }),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: qk.sources.all })
      const prev = qc.getQueryData<Source[]>(qk.sources.all)
      qc.setQueryData<Source[]>(qk.sources.all, (old = []) =>
        old.map((s) => (s.id === id ? { ...s, enabled } : s)),
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(qk.sources.all, ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.sources.all }),
  })
}

/** Create or update a source (used by the edit / add modals). */
export function useSaveSource() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (source: Source) => {
      // Last-run facts belong to the service, not to the form.
      const body: Partial<Source> = { ...source }
      delete body.id
      delete body.lastRunAt
      delete body.lastRunStatus
      return apiSend('PUT', `/api/sources/${encodeURIComponent(source.id)}`, body)
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.sources.all }),
  })
}
