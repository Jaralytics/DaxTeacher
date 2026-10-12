import { useCallback, useEffect, useState } from 'react'

const STEP_MS = 1100

/** Cursor de fila con avance automatico opcional. */
export function useRowCursor(count: number) {
  const [state, setState] = useState({ index: 0, playing: false })
  const index = Math.min(state.index, Math.max(count - 1, 0))

  useEffect(() => {
    if (!state.playing) return
    const id = window.setTimeout(() => {
      setState((s) => (s.index >= count - 1 ? { ...s, playing: false } : { ...s, index: s.index + 1 }))
    }, STEP_MS)
    return () => window.clearTimeout(id)
  }, [state.playing, state.index, count])

  const set = useCallback((i: number) => setState({ index: i, playing: false }), [])
  const prev = useCallback(() => setState((s) => ({ index: Math.max(0, s.index - 1), playing: false })), [])
  const next = useCallback(
    () => setState((s) => ({ index: Math.min(count - 1, s.index + 1), playing: false })),
    [count],
  )
  const restart = useCallback(() => setState({ index: 0, playing: false }), [])
  const toggle = useCallback(
    () => setState((s) => (s.playing ? { ...s, playing: false } : { index: s.index >= count - 1 ? 0 : s.index, playing: true })),
    [count],
  )

  return { index, playing: state.playing, count, set, prev, next, restart, toggle }
}

export type RowCursor = ReturnType<typeof useRowCursor>
