import { useRef } from 'react'
import type { KeyboardEvent } from 'react'
import type { Value } from '../../engine'
import { parseColumn } from './helpers'

interface Props {
  rowField: string
  colField: string
  rows: Value[]
  cols: Value[]
  /** (filas + 1) x (columnas + 1); la ultima fila y columna son totales. undefined = sin dato. */
  values: (Value | undefined)[][]
  selected: { r: number; c: number }
  onSelect: (cell: { r: number; c: number }) => void
}

function label(v: Value): string {
  return v === null ? '(en blanco)' : String(v)
}

/** Matriz tipo visual de Power BI, como cuadricula con tabindex itinerante. */
export function Matrix({ rowField, colField, rows, cols, values, selected, onSelect }: Props) {
  const ref = useRef<HTMLTableElement>(null)

  function move(r: number, c: number) {
    const rr = Math.max(0, Math.min(rows.length, r))
    const cc = Math.max(0, Math.min(cols.length, c))
    onSelect({ r: rr, c: cc })
    ref.current?.querySelector<HTMLElement>(`[data-r="${rr}"][data-c="${cc}"]`)?.focus()
  }

  function onKeyDown(e: KeyboardEvent<HTMLTableElement>) {
    const { r, c } = selected
    const keys: Record<string, [number, number]> = {
      ArrowUp: [r - 1, c],
      ArrowDown: [r + 1, c],
      ArrowLeft: [r, c - 1],
      ArrowRight: [r, c + 1],
      Home: [r, 0],
      End: [r, cols.length],
    }
    const target = keys[e.key]
    if (!target) return
    e.preventDefault()
    move(target[0], target[1])
  }

  const rowName = parseColumn(rowField).column
  const colName = parseColumn(colField).column

  return (
    <div className="matrix-scroll">
      <table
        ref={ref}
        className="matrix"
        role="grid"
        aria-label={`Matriz de ${rowName} por ${colName}`}
        onKeyDown={onKeyDown}
      >
        <thead>
          <tr role="row">
            <th scope="col" className="matrix-corner">
              {rowName} / {colName}
            </th>
            {cols.map((c, ci) => (
              <th key={ci} scope="col" role="columnheader">
                {label(c)}
              </th>
            ))}
            <th scope="col" role="columnheader" className="is-total">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows.length + 1 }, (_, r) => (
            <tr key={r} role="row" className={r === rows.length ? 'is-total-row' : ''}>
              <th scope="row" role="rowheader" className={r === rows.length ? 'is-total' : ''}>
                {r === rows.length ? 'Total' : label(rows[r])}
              </th>
              {Array.from({ length: cols.length + 1 }, (_, c) => {
                const v = values[r]?.[c]
                const isSel = selected.r === r && selected.c === c
                return (
                  <td
                    key={c}
                    role="gridcell"
                    data-r={r}
                    data-c={c}
                    tabIndex={isSel ? 0 : -1}
                    aria-selected={isSel}
                    className={`matrix-cell${isSel ? ' is-selected' : ''}${c === cols.length || r === rows.length ? ' is-total' : ''}`}
                    onClick={() => onSelect({ r, c })}
                  >
                    {v === null || v === undefined ? '' : String(v)}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
