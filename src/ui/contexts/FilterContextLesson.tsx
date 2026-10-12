import { useMemo, useState } from 'react'
import { sampleModel } from '../../data/sampleModel'
import type { Value } from '../../engine'
import { probe } from '../../engine/probe'
import type { ProbeResult } from '../../engine/probe'
import { formatPlain } from '../format'
import {
  FIELD_OPTIONS,
  MEASURES,
  SLICER_FIELD,
  cellFilters,
  cellSentence,
  distinctValues,
  filterPredicate,
  isDimension,
  parseColumn,
  playerFormula,
  relationBetween,
  tablesRead,
} from './helpers'
import { Matrix } from './Matrix'
import { LessonFrame, MiniTable } from './shared'

interface Props {
  idPrefix: string
  onOpenInPlayer: (formula: string) => void
}

const DEFINITION =
  'El contexto de filtro es el conjunto de filtros activos en el momento de calcular un valor: las filas y columnas de una visual, las segmentaciones y los filtros de CALCULATE. Solo las filas que superan todos esos filtros participan en el cálculo.'
const IDEA =
  'Cada celda se calcula por separado, con su propio contexto de filtro. El total no es la suma de las celdas: es la misma fórmula con menos filtros.'

export function FilterContextLesson({ idPrefix, onOpenInPlayer }: Props) {
  const [rowField, setRowField] = useState('Productos[Proveedor]')
  const [colField, setColField] = useState('Calendario[NombreMes]')
  const [measureId, setMeasureId] = useState('ventas')
  const [slicer, setSlicer] = useState<Value[]>([])
  const [sel, setSel] = useState({ r: 0, c: 0 })

  const measure = MEASURES.find((m) => m.id === measureId) ?? MEASURES[0]
  const rowVals = useMemo(() => distinctValues(sampleModel, rowField), [rowField])
  const colVals = useMemo(() => distinctValues(sampleModel, colField), [colField])
  const slicerVals = useMemo(() => distinctValues(sampleModel, SLICER_FIELD), [])
  const slicerHidden = SLICER_FIELD === rowField || SLICER_FIELD === colField

  const spec = (r: number, c: number) => ({
    rowField,
    rowValue: r < rowVals.length ? rowVals[r] : undefined,
    colField,
    colValue: c < colVals.length ? colVals[c] : undefined,
    slicerField: SLICER_FIELD,
    slicerValues: slicer,
  })

  const grid = useMemo(() => {
    const out: ProbeResult[][] = []
    for (let r = 0; r <= rowVals.length; r++) {
      const line: ProbeResult[] = []
      for (let c = 0; c <= colVals.length; c++) {
        const filters = cellFilters({
          rowField,
          rowValue: r < rowVals.length ? rowVals[r] : undefined,
          colField,
          colValue: c < colVals.length ? colVals[c] : undefined,
          slicerField: SLICER_FIELD,
          slicerValues: slicer,
        })
        line.push(probe(measure.formula, sampleModel, { filters }))
      }
      out.push(line)
    }
    return out
  }, [rowField, colField, rowVals, colVals, slicer, measure])

  const r = Math.min(sel.r, rowVals.length)
  const c = Math.min(sel.c, colVals.length)
  const filters = cellFilters(spec(r, c))
  const result = grid[r]?.[c]
  const firstError = grid.flat().find((x) => !x.ok)
  const values = grid.map((line) => line.map((x) => (x.ok ? x.value : undefined)))

  // Tablas implicadas: dimensiones de filas/columnas, tablas que lee la medida y la de la segmentacion.
  const names = new Set<string>([parseColumn(rowField).table, parseColumn(colField).table, ...tablesRead(measure.formula, sampleModel)])
  if (!slicerHidden && slicer.length > 0) names.add(parseColumn(SLICER_FIELD).table)
  const shown = sampleModel.tables
    .filter((t) => names.has(t.name))
    .sort((a, b) => Number(isDimension(sampleModel, b.name)) - Number(isDimension(sampleModel, a.name)))
  const facts = shown.filter((t) => !isDimension(sampleModel, t.name))

  const captions: string[] = []
  for (const f of filters) {
    const ft = parseColumn(f.column).table
    if (isDimension(sampleModel, ft)) {
      for (const fact of facts) {
        const rel = relationBetween(sampleModel, ft, fact.name)
        if (rel) {
          captions.push(
            `${f.column}: el filtro viaja por ${rel.toTable}[${rel.toColumn}] -> ${rel.fromTable}[${rel.fromColumn}] hasta ${fact.name}.`,
          )
        }
      }
    } else {
      captions.push(`${f.column} está en ${ft}: filtra directamente esa tabla.`)
      for (const fact of facts) {
        if (fact.name !== ft) captions.push(`${f.column} no llega a ${fact.name}: no hay relación entre las dos tablas de hechos.`)
      }
    }
  }

  const highlightFor = (table: string): string[] => {
    const cols = [...measure.columns, rowField, colField, ...(slicerHidden ? [] : [SLICER_FIELD])]
      .map(parseColumn)
      .filter((x) => x.table === table)
      .map((x) => x.column)
    return cols
  }

  function changeRow(f: string) {
    if (f === colField) setColField(rowField)
    setRowField(f)
    setSel({ r: 0, c: 0 })
  }

  function changeCol(f: string) {
    if (f === rowField) setRowField(colField)
    setColField(f)
    setSel({ r: 0, c: 0 })
  }

  function toggleCity(v: Value) {
    setSlicer((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]))
  }

  return (
    <LessonFrame idPrefix={idPrefix} tabKey="filtro" title="Contexto de filtro" definition={DEFINITION} idea={IDEA}>
      <div className="ctx-form">
        <label className="field">
          <span>Filas</span>
          <select value={rowField} onChange={(e) => changeRow(e.target.value)}>
            {FIELD_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Columnas</span>
          <select value={colField} onChange={(e) => changeCol(e.target.value)}>
            {FIELD_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="field field-wide">
          <span>Medida</span>
          <select
            value={measureId}
            onChange={(e) => {
              setMeasureId(e.target.value)
            }}
          >
            {MEASURES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.formula}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!slicerHidden && (
        <div className="slicer" role="group" aria-label={`Segmentación de ${SLICER_FIELD}`}>
          <span className="slicer-title">Segmentación {SLICER_FIELD}</span>
          {slicerVals.map((v) => (
            <button
              key={String(v)}
              type="button"
              className="chip"
              aria-pressed={slicer.includes(v)}
              onClick={() => toggleCity(v)}
            >
              {String(v)}
            </button>
          ))}
          {slicer.length === 0 && <span className="slicer-hint">Sin selección: no filtra</span>}
        </div>
      )}

      {firstError && !firstError.ok && (
        <p className="error-msg" role="alert">
          {firstError.error.message}
        </p>
      )}

      <div className="ctx-split">
        <div className="card matrix-card">
          <Matrix
            rowField={rowField}
            colField={colField}
            rows={rowVals}
            cols={colVals}
            values={values}
            selected={{ r, c }}
            onSelect={setSel}
          />
        </div>

        <aside className="card cell-card" aria-label="Contexto de filtro de esta celda">
          <h3 className="card-title">Contexto de filtro de esta celda</h3>
          {filters.length === 0 ? (
            <p className="ctx-empty">Sin filtros</p>
          ) : (
            <ul className="chip-list">
              {filters.map((f) => (
                <li key={f.column} className="filter-chip">
                  {filterPredicate(f)}
                </li>
              ))}
            </ul>
          )}
          <p className="cell-sentence">{cellSentence(measure.label, filters)}</p>
          {result?.ok && (
            <p className="cell-value">
              <span className="scalar-label">Valor</span>
              <span className="scalar-value">{result.value === null ? '(en blanco)' : formatPlain(result.value)}</span>
            </p>
          )}
          <button
            type="button"
            className="link-btn"
            onClick={() => onOpenInPlayer(playerFormula(measure.formula, filters))}
          >
            Ver paso a paso en el reproductor
          </button>
        </aside>
      </div>

      {captions.length > 0 && (
        <ul className="ctx-captions">
          {captions.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}

      <div className="ctx-tables">
        {shown.map((t) => (
          <MiniTable
            key={t.name}
            table={t}
            visible={result?.ok ? (result.visibleRows[t.name] ?? null) : null}
            highlight={highlightFor(t.name)}
          />
        ))}
      </div>
    </LessonFrame>
  )
}
