import type { KeyboardEvent, ReactNode } from 'react'
import type { Table, Value } from '../../engine'
import { formatPlain, formatValue } from '../format'
import { NextIcon, PauseIcon, PlayIcon, PrevIcon, RestartIcon } from '../icons'
import { panelId, tabId } from './Segmented'
import type { RowCursor } from './useRowCursor'

interface FrameProps {
  idPrefix: string
  tabKey: string
  title: string
  definition: string
  idea: string
  children: ReactNode
}

/** Marco comun de una leccion: definicion arriba, contenido interactivo e idea clave abajo. */
export function LessonFrame({ idPrefix, tabKey, title, definition, idea, children }: FrameProps) {
  return (
    <div className="lesson" role="tabpanel" id={panelId(idPrefix)} aria-labelledby={tabId(idPrefix, tabKey)}>
      <h2 className="lesson-title">{title}</h2>
      <p className="lesson-def">{definition}</p>
      {children}
      <p className="lesson-idea">
        <strong>Idea clave.</strong> {idea}
      </p>
    </div>
  )
}

interface MiniProps {
  table: Table
  /** Indices de filas visibles; null = todas visibles. */
  visible: number[] | null
  /** Columnas resaltadas (nombres sin tabla). */
  highlight?: string[]
  /** Fila actual (contexto de fila). */
  active?: number | null
  extra?: { name: string; values: Value[] }
  onRowClick?: (index: number) => void
  caption?: string
}

/** Tabla del modelo con todas sus filas; las no visibles se atenuan y se tachan. */
export function MiniTable({ table, visible, highlight = [], active = null, extra, onRowClick, caption }: MiniProps) {
  const shown = visible ? new Set(visible) : null

  function onKey(e: KeyboardEvent<HTMLTableRowElement>, i: number) {
    if (onRowClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      onRowClick(i)
    }
  }

  return (
    <section className="table-card mini-card" aria-label={table.name}>
      <header className="table-head">
        <h3>{table.name}</h3>
        <span className="role-tag">
          {shown ? `${shown.size} de ${table.rows.length} filas` : `${table.rows.length} filas`}
        </span>
      </header>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th className="mark-col" aria-label="Estado" />
              {table.columns.map((c) => (
                <th key={c.name} scope="col" className={highlight.includes(c.name) ? 'is-highlight' : ''}>
                  {c.name}
                </th>
              ))}
              {extra && (
                <th scope="col" className="is-highlight is-new">
                  {extra.name}
                  <span className="new-tag">nueva</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => {
              const hidden = shown !== null && !shown.has(i)
              const isActive = active === i
              const status = isActive ? 'active' : hidden ? 'removed' : 'normal'
              return (
                <tr
                  key={i}
                  className={`status-${status}${onRowClick ? ' is-clickable' : ''}`}
                  aria-current={isActive ? 'true' : undefined}
                  tabIndex={onRowClick ? 0 : undefined}
                  onClick={onRowClick ? () => onRowClick(i) : undefined}
                  onKeyDown={onRowClick ? (e) => onKey(e, i) : undefined}
                >
                  <td className="mark-col">
                    <span className="sr-only">{isActive ? 'Fila actual' : hidden ? 'Fila no visible' : ''}</span>
                  </td>
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className={`${typeof cell === 'number' ? 'num' : ''}${highlight.includes(table.columns[j]?.name) ? ' is-highlight' : ''}`}
                    >
                      {formatValue(cell, table.columns[j]?.type)}
                    </td>
                  ))}
                  {extra && (
                    <td className={`num extra-cell${typeof extra.values[i] === 'number' ? '' : ' is-text'}`}>
                      {formatValue(extra.values[i] ?? null)}
                    </td>
                  )}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {caption && <p className="mini-caption">{caption}</p>}
    </section>
  )
}

/** Tarjeta con los pares columna = valor de una fila. */
export function RowCard({ table, rowIndex, title = 'Fila actual' }: { table: Table; rowIndex: number; title?: string }) {
  const row = table.rows[rowIndex]
  return (
    <section className="card" aria-label={title}>
      <h3 className="card-title">{title}</h3>
      {row ? (
        <ul className="pairs">
          {table.columns.map((c, i) => (
            <li key={c.name}>
              <span className="pair-col">{table.name}[{c.name}]</span>
              <span className="pair-eq"> = </span>
              <span className="pair-val">{formatPlain(row[i], c.type)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="ctx-empty">No hay fila actual</p>
      )}
    </section>
  )
}

/** Controles para recorrer filas, con el aspecto de la barra del reproductor. */
export function RowControls({ cursor }: { cursor: RowCursor }) {
  return (
    <div className="row-controls" role="group" aria-label="Recorrer filas">
      <button type="button" className="icon-btn" onClick={cursor.restart} aria-label="Primera fila">
        <RestartIcon />
      </button>
      <button type="button" className="icon-btn" onClick={cursor.prev} disabled={cursor.index === 0} aria-label="Fila anterior">
        <PrevIcon />
      </button>
      <button
        type="button"
        className="icon-btn play-btn"
        onClick={cursor.toggle}
        aria-label={cursor.playing ? 'Pausar' : 'Recorrer automáticamente'}
      >
        {cursor.playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={cursor.next}
        disabled={cursor.index >= cursor.count - 1}
        aria-label="Fila siguiente"
      >
        <NextIcon />
      </button>
      <span className="row-counter" aria-live="polite">
        Fila {cursor.index + 1} de {cursor.count}
      </span>
    </div>
  )
}
