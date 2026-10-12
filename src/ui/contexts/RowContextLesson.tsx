import { useMemo, useState } from 'react'
import { sampleModel } from '../../data/sampleModel'
import type { Value } from '../../engine'
import { probe } from '../../engine/probe'
import type { ProbeResult } from '../../engine/probe'
import { formatPlain } from '../format'
import { columnFormula, relatedRowIndex, substituteRow } from './helpers'
import { LessonFrame, MiniTable, RowCard, RowControls } from './shared'
import { useRowCursor } from './useRowCursor'

interface Props {
  idPrefix: string
  onOpenInPlayer: (formula: string) => void
}

const DEFINITION =
  'El contexto de fila existe mientras DAX recorre una tabla fila por fila, ya sea en una columna calculada o en un iterador como SUMX o ADDCOLUMNS. Indica cuál es la fila actual y permite leer los valores de sus columnas.'
const IDEA =
  'El contexto de fila le dice a DAX en qué fila está: sirve para leer las columnas de esa fila, pero no filtra nada.'

const PRESETS = [
  { id: 'importe', expr: 'Ventas[Cantidad] * Ventas[Precio]', note: 'Lee solo valores de la fila actual.' },
  { id: 'related', expr: 'RELATED(Productos[Marca])', note: 'Sigue la relación desde la fila actual hasta Productos.' },
  { id: 'suma', expr: 'SUM(Ventas[Cantidad])', note: 'El error clásico: un agregador no mira la fila actual.' },
]

const ventas = sampleModel.tables.find((t) => t.name === 'Ventas')!
const productos = sampleModel.tables.find((t) => t.name === 'Productos')!

export function RowContextLesson({ idPrefix, onOpenInPlayer }: Props) {
  const [presetId, setPresetId] = useState('importe')
  const preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]
  const cursor = useRowCursor(ventas.rows.length)

  const results = useMemo<ProbeResult[]>(
    () => ventas.rows.map((_, i) => probe(preset.expr, sampleModel, { row: { table: 'Ventas', rowIndex: i } })),
    [preset],
  )
  const current = results[cursor.index]
  const values: Value[] = results.map((x) => (x.ok ? x.value : null))
  const error = results.find((x) => !x.ok)

  const substituted = substituteRow(preset.expr, sampleModel, 'Ventas', cursor.index)
  const scanned = current?.ok ? (current.scannedRows['Ventas'] ?? []) : []
  const rowLevel = scanned.length <= 1
  const lit = (i: number) => scanned.includes(i) || (rowLevel && i === cursor.index)
  const related = preset.id === 'related' ? relatedRowIndex(sampleModel, 'Ventas', cursor.index, 'Productos') : null

  return (
    <LessonFrame idPrefix={idPrefix} tabKey="fila" title="Contexto de fila" definition={DEFINITION} idea={IDEA}>
      <div className="ctx-form">
        <div className="field field-wide" role="group" aria-label="Expresión de la columna nueva">
          <span>Expresión de la columna nueva</span>
          <div className="chip-row">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="chip chip-mono"
                aria-pressed={p.id === presetId}
                onClick={() => setPresetId(p.id)}
              >
                {p.expr}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="lesson-note">{preset.note}</p>

      {error && !error.ok && (
        <p className="error-msg" role="alert">
          {error.error.message}
        </p>
      )}

      <RowControls cursor={cursor} />

      <div className="ctx-split">
        <MiniTable
          table={ventas}
          visible={null}
          active={cursor.index}
          extra={{ name: 'Resultado', values }}
          onRowClick={cursor.set}
          highlight={preset.id === 'related' ? ['Producto'] : ['Cantidad', 'Precio']}
        />

        <div className="side-cards">
          <RowCard table={ventas} rowIndex={cursor.index} />

          <section className="card" aria-label="Cálculo de la fila actual">
            <h3 className="card-title">Cálculo en esta fila</h3>
            <code className="calc-expr">{preset.expr}</code>
            {current?.ok && (
              <p className="calc-line">
                {substituted ? `${substituted} = ` : '= '}
                <strong>{current.value === null ? '(en blanco)' : formatPlain(current.value)}</strong>
              </p>
            )}
          </section>

          <section className="card" aria-label="Filas que ve la fórmula">
            <h3 className="card-title">Filas que ve la fórmula</h3>
            <div className="dots" role="img" aria-label={`${scanned.length} de ${ventas.rows.length} filas leídas`}>
              {ventas.rows.map((_, i) => (
                <span
                  key={i}
                  className={`dot${lit(i) ? ' is-lit' : ''}${i === cursor.index ? ' is-current' : ''}`}
                />
              ))}
            </div>
            <p className="calc-note">
              {rowLevel
                ? 'La expresión solo lee los valores de la fila actual.'
                : `La fórmula leyó ${scanned.length} de ${ventas.rows.length} filas de Ventas aunque el cursor esté en una sola: el contexto de fila no filtra.`}
            </p>
          </section>

          <button
            type="button"
            className="link-btn"
            onClick={() => onOpenInPlayer(columnFormula('Ventas', 'Resultado', preset.expr))}
          >
            Ver paso a paso en el reproductor
          </button>
        </div>
      </div>

      {preset.id === 'related' && (
        <div className="ctx-tables">
          <MiniTable
            table={productos}
            visible={null}
            active={related}
            highlight={['Producto', 'Marca']}
            caption="Fila de Productos encontrada por la relación Ventas[Producto] -> Productos[Producto]."
          />
        </div>
      )}
    </LessonFrame>
  )
}
