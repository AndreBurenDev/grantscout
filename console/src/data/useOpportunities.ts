import { useQuery } from '@tanstack/react-query'
import { apiGet, type Row } from '@/lib/api'
import { qk } from './keys'
import { toGrantOpportunity } from './converters'
import type { GrantOpportunity } from './types'

const STATUS_ORDER: Record<string, number> = {
  active: 0,
  upcoming: 1,
  closed: 2,
  archived: 3,
}

export function useOpportunities() {
  return useQuery({
    queryKey: qk.opportunities.all,
    queryFn: async (): Promise<GrantOpportunity[]> =>
      (await apiGet<Row[]>('/api/grants'))
        .map((r) => toGrantOpportunity(r.id, r.data))
        .sort((a, b) => {
          const s = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
          if (s !== 0) return s
          return (a.dateClose?.getTime() ?? Infinity) - (b.dateClose?.getTime() ?? Infinity)
        }),
  })
}
