import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiSend, type Row } from '@/lib/api'
import { qk } from './keys'
import { toSettings } from './converters'
import type { ConsoleSettings } from './types'

export function useSettings() {
  return useQuery({
    queryKey: qk.settings.all,
    queryFn: async (): Promise<ConsoleSettings> => {
      const res = await apiGet<{ data: Row['data'] | null }>('/api/settings')
      return toSettings(res.data ?? undefined)
    },
  })
}

export function useSaveSettings() {
  const qc = useQueryClient()
  return useMutation({
    // The service stamps updatedAt / updatedBy from the caller's tailnet identity.
    mutationFn: (settings: ConsoleSettings) =>
      apiSend('PUT', '/api/settings', {
        autoRunEnabled: settings.autoRunEnabled,
        emailOnFailure: settings.emailOnFailure,
        debugLogging: settings.debugLogging,
        minRelevanceScore: settings.minRelevanceScore,
        minFitScore: settings.minFitScore,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.settings.all }),
  })
}
