import type { PartialResult, SourceSpan, TableSnapshot, TraceStep } from '../engine'
import { DataTable } from './DataTable'
import { formatPlain } from './format'
import { useGhosts } from './useGhosts'

const tableKey = (t: TableSnapshot) => t.id
const EMPTY: TableSnapshot[] = []
const LETTERS = ['A', 'B', 'C']

interface Props {
  step: TraceStep | null
  onHoverSpan?: (span: SourceSpan | null) => void
}

/** Texto que explica por que relacion viaja el filtro en este paso. */
function captionFor(step: TraceStep): string | null {
  const rels = step.relationships ?? []
  if (step.kind === 'propagate') {
    const used = rels.find((r) => r.used)
    if (used) return `Relación en uso: el filtro viaja de ${used.to} (lado uno) a ${used.from} (lado muchos).`
  }
  if (step.kind === 'relationship-change') {
    const on = rels.find((r) => r.status === 'activated')
    if (on) return `Relación activada para este cálculo: ${on.from} -> ${on.to}.`
  }
  return null
}

const norm = (s: string) => s.toLowerCase()

function matchesTable(table: TableSnapshot, name: string): boolean {
  const n = norm(name)
  return norm(table.id) === n || norm(table.title) === n || norm(table.title).startsWith(`${n} `)
}

/** Letra de cada tabla y de cada tabla de origen, para vincular chips y tarjetas. */
function buildMarkers(tables: TableSnapshot[], partials: PartialResult[]) {
  const sources = Array.from(new Set(partials.map((p) => p.sourceTable).filter((s): s is string => !!s)))
  const sourceLetter = new Map(sources.map((s, i) => [s, LETTERS[i % LETTERS.length]]))
  const tableLetter = new Map<string, string>()
  for (const [name, letter] of sourceLetter) {
    const t = tables.find((x) => matchesTable(x, name))
    if (t) tableLetter.set(t.id, letter)
  }
  // Funciones de conjunto: dos tablas de trabajo, A y B.
  if (tableLetter.size === 0 && tables.length === 2 && tables.every((t) => t.role === 'working')) {
    tables.forEach((t, i) => tableLetter.set(t.id, LETTERS[i]))
  }
  return { sourceLetter, tableLetter }
}

function Arrow() {
  return (
    <svg className="partials-arrow" width="34" height="14" viewBox="0 0 34 14" aria-hidden="true" focusable="false">
      <path d="M1 7h30M25 1.5 31 7l-6 5.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function Stage({ step, onHoverSpan }: Props) {
  const list = useGhosts(step ? step.tables : EMPTY, tableKey)
  const caption = step ? captionFor(step) : null
  const partials = step?.partials ?? []
  const combine = step?.kind === 'combine' && step.scalar ? step.scalar : null
  const liveCount = step ? step.tables.length : 0
  const { sourceLetter, tableLetter } = buildMarkers(step ? step.tables : EMPTY, partials)

  return (
    <div className={`stage${liveCount === 2 ? ' is-pair' : ''}`}>
      {step && (
        // Se reserva siempre la altura para que la escena no salte entre pasos.
        <p className={`stage-caption${caption ? ' is-on' : ''}`} aria-live="off">
          {caption}
        </p>
      )}
      {list.length === 0 && (
        <p className="stage-empty">
          Pulsa <strong>Ejecutar</strong> para ver cómo se transforman las tablas paso a paso.
        </p>
      )}
      {list.map(({ item, leaving }) => (
        <DataTable key={item.id} table={item} leaving={leaving} marker={tableLetter.get(item.id)} />
      ))}

      {(partials.length > 0 || combine) && (
        <section className="partials" aria-label="Resultados parciales">
          <h3 className="partials-title">Resultados parciales</h3>
          <div className="partials-row">
            {partials.map((p) => {
              const letter = p.sourceTable ? sourceLetter.get(p.sourceTable) : undefined
              return (
                <div
                  key={`${p.span.start}-${p.span.end}`}
                  className="partial-chip"
                  tabIndex={0}
                  aria-label={`${p.label} es ${formatPlain(p.value)}${p.sourceTable ? `, de ${p.sourceTable}` : ''}`}
                  onMouseEnter={() => onHoverSpan?.(p.span)}
                  onMouseLeave={() => onHoverSpan?.(null)}
                  onFocus={() => onHoverSpan?.(p.span)}
                  onBlur={() => onHoverSpan?.(null)}
                >
                  <span className="partial-label">{p.label}</span>
                  <span className="partial-value">{formatPlain(p.value)}</span>
                  {p.sourceTable && (
                    <span className="partial-source">
                      {letter && <span className={`mark-dot tone-${letter.toLowerCase()}`}>{letter}</span>}
                      {p.sourceTable}
                    </span>
                  )}
                </div>
              )
            })}
            {combine && (
              <>
                <Arrow />
                <div className="partial-chip partial-result">
                  <span className="partial-label">{combine.label}</span>
                  <span className="partial-value">{formatPlain(combine.value)}</span>
                </div>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
