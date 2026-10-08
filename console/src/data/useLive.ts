import { useQuery } from '@tanstack/react-query'
import { apiGet, type Row } from '@/lib/api'

export interface LiveState<T> {
  data: T[] | undefined
  isLoading: boolean
  isError: boolean
  error: unknown
  retry: () => void
}

const POLL_MS = 5000

/**
 * A list that keeps itself current by polling the API every few seconds (it used to be a Firestore
 * listener). Same shape as before, so screens did not change. Polling pauses while the tab is hidden.
 */
export function useLiveCollection<T>(
  queryKey: readonly unknown[],
  path: string,
  map: (id: string, data: Row['data']) => T,
  postProcess?: (items: T[]) => T[],
): LiveState<T> {
  const q = useQuery({
    queryKey,
    queryFn: async (): Promise<T[]> => {
      const items = (await apiGet<Row[]>(path)).map((r) => map(r.id, r.data))
      return postProcess ? postProcess(items) : items
    },
    refetchInterval: POLL_MS,
  })

  return {
    data: q.data,
    isLoading: q.isLoading,
    isError: q.isError,
    error: q.error,
    retry: () => void q.refetch(),
  }
}
