import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiSend } from '@/lib/api'
import { qk } from './keys'
import { toReviewItem } from './converters'
import { useLiveCollection } from './useLive'

/** Live pending review queue, newest first. */
export function useLiveReviewQueue() {
  return useLiveCollection(qk.review.all, '/api/review?status=pending', toReviewItem, (items) =>
    [...items].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0)),
  )
}

type Decision = 'approved' | 'rejected'

/** Approve/reject a review item. The service records who decided and when. */
export function useReviewDecision() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: Decision }) =>
      apiSend('POST', `/api/review/${encodeURIComponent(id)}/decision`, { decision }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: qk.review.all })
      void qc.invalidateQueries({ queryKey: qk.overview.all })
    },
  })
}
