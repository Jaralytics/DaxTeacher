import { useMemo, useState } from 'react'
import { sampleModel } from '../../data/sampleModel'
import type { Value } from '../../engine'
import { probe } from '../../engine/probe'
import type { ProbeResult } from '../../engine/probe'
import { FilterContext } from '../ContextPanels'
import { columnFormula } from './helpers'
import { LessonFrame, MiniTable, RowCard, RowControls } from './shared'
import { useRowCursor } from './useRowCursor'

interface Props {
  idPrefix: string
  onOpenInPlayer: (formula: string) => void
}

const DEFINITION =
  'Cuando una medida o CALCULATE se evalúa dentro de un contexto de fila, DAX convierte los valores de la fila actual en filtros sobre las tablas relacionadas. Ese paso se llama transición de contexto.'
const IDEA = 'Solo CALCULATE (o una medida) convierte el contexto de fila en contexto de filtro.'

const EXPRESSIONS = [
  { id: 'sin', expr: 'SUM(Ventas[Cantidad])', label: 'Sin CALCULATE' },
  { id: 'con', expr: 'CALCULATE(SUM(Ventas[Cantidad]))', label: 'Con CALCULATE' },
]

const productos = sampleModel.tables.find((t) => t.name === 'Productos')!
const ventas = sampleModel.tables.find((t) => t.name === 'Ventas')!

export function TransitionLesson({ idPrefix, onOpenInPlayer }: Props) {
  const [exprId, setExprId] = useState('con')
  const item = EXPRESSIONS.find((e) => e.id === exprId) ?? EXPRESSIONS[1]
  const cursor = useRowCursor(productos.rows.length)

  const results = useMemo<ProbeResult[]>(
    () => productos.rows.map((_, i) => probe(item.expr, sampleModel, { row: { table: 'Productos', rowIndex: i } })),
    [item],
  )
  const current = results[cursor.index]
  const values: Value[] = results.map((x) => (x.ok ? x.value : null))
  const error = results.find((x) => !x.ok)
  const scanned = current?.ok ? (current.scannedRows['Ventas'] ?? null) : null

  return (
    <LessonFrame idPrefix={idPrefix} tabKey="transicion" title="Transición de contexto" definition={DEFINITION} idea={IDEA}>
      <div className="ctx-form">
        <div className="field field-wide" role="group" aria-label="Expresión de la columna Total">
          <span>Expresión de la columna Total</span>
          <div className="chip-row">
            {EXPRESSIONS.map((e) => (
              <button
                key={e.id}
                type="button"
                className="chip chip-mono"
                aria-pressed={e.id === exprId}
                onClick={() => setExprId(e.id)}
              >
                {e.expr}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && !error.ok && (
        <p className="error-msg" role="alert">
          {error.error.message}
        </p>
      )}

      <RowControls cursor={cursor} />

      <div className="ctx-split">
        <MiniTable
          table={productos}
          visible={null}
          active={cursor.index}
          extra={{ name: 'Total', values }}
          onRowClick={cursor.set}
          highlight={['Producto']}
        />
        <MiniTable
          table={ventas}
          visible={scanned}
          highlight={['Producto', 'Cantidad']}
          caption={
            scanned
              ? `${scanned.length} de ${ventas.rows.length} filas de Ventas visibles para SUM en la fila actual.`
              : undefined
          }
        />
      </div>

      <div className="ctx-split">
        <RowCard table={productos} rowIndex={cursor.index} />

        <div className="side-cards">
          <section className="card" aria-label="Estado de la transición">
            <h3 className="card-title">Transición</h3>
            {current?.ok && (
              <p className={`transition-state${current.contextTransition ? ' is-on' : ''}`}>
                {current.contextTransition
                  ? 'Transición: la fila actual se convirtió en filtro.'
                  : 'Sin transición: la fila no filtra.'}
              </p>
            )}
            {current?.ok && (
              <FilterContext entries={current.innerFilterContext} title="Contexto de filtro dentro de CALCULATE" />
            )}
          </section>
          <button
            type="button"
            className="link-btn"
            onClick={() => onOpenInPlayer(columnFormula('Productos', 'Total', item.expr))}
          >
            Ver paso a paso en el reproductor
          </button>
        </div>
      </div>
    </LessonFrame>
  )
}
