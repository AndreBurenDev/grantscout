import { useQuery } from '@tanstack/react-query'
import { apiGet, type Row } from '@/lib/api'
import { qk } from './keys'
import { toAccountScore } from './converters'
import type { AccountScore } from './types'

export function useScores() {
  return useQuery({
    queryKey: qk.scores.all,
    queryFn: async (): Promise<AccountScore[]> =>
      // The API joins the organisation name onto each score.
      (await apiGet<(Row & { orgName?: string })[]>('/api/scores'))
        .map((r) => {
          const score = toAccountScore(r.id, r.data)
          return { ...score, orgName: r.orgName ?? score.orgId }
        })
        .sort((a, b) => b.score - a.score),
  })
}
