import { useCallback, useEffect, useRef, useState } from "react"

type State<T> = { data: T | null; error: unknown; loading: boolean }

// Minimal server-state hook: refetches when `key` changes, optional polling.
// Pass key = null to skip.
export function useApi<T>(key: string | null, fetcher: () => Promise<T>, options?: { pollMs?: number | null }) {
  const [state, setState] = useState<State<T>>({ data: null, error: null, loading: key !== null })
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const keyRef = useRef(key)
  keyRef.current = key

  const reload = useCallback(async () => {
    const requested = keyRef.current
    if (requested === null) return
    try {
      const data = await fetcherRef.current()
      if (keyRef.current === requested) setState({ data, error: null, loading: false })
    } catch (error) {
      if (keyRef.current === requested) setState((s) => ({ data: s.data, error, loading: false }))
    }
  }, [])

  useEffect(() => {
    if (key === null) return
    setState({ data: null, error: null, loading: true })
    void reload()
  }, [key, reload])

  const pollMs = options?.pollMs ?? null
  useEffect(() => {
    if (key === null || !pollMs) return
    const t = setInterval(() => void reload(), pollMs)
    return () => clearInterval(t)
  }, [key, pollMs, reload])

  return { ...state, reload }
}
