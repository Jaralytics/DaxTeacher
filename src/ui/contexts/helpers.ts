// Ayudas puras (sin DOM) de la vista "Contextos".
import type { DataModel, Value } from '../../engine'
import type { ContextFilter } from '../../engine/probe'

export interface ColumnRef {
  table: string
  column: string
}

export function parseColumn(qualified: string): ColumnRef {
  const m = /^'?(.*?)'?\[(.*)\]$/.exec(qualified)
  return m ? { table: m[1], column: m[2] } : { table: '', column: qualified }
}

/** Valores distintos de una columna calificada, en el orden de aparicion del modelo. */
export function distinctValues(model: DataModel, qualified: string): Value[] {
  const { table, column } = parseColumn(qualified)
  const t = model.tables.find((x) => x.name === table)
  const idx = t ? t.columns.findIndex((c) => c.name === column) : -1
  if (!t || idx < 0) return []
  const seen: Value[] = []
  for (const row of t.rows) if (!seen.includes(row[idx])) seen.push(row[idx])
  return seen
}

export interface CellSpec {
  rowField: string
  /** undefined = total de filas (sin filtro sobre rowField). */
  rowValue?: Value
  colField: string
  colValue?: Value
  slicerField: string
  slicerValues: Value[]
}

/** Filtros del contexto de una celda de la matriz. Los totales omiten el filtro que corresponde. */
export function cellFilters(spec: CellSpec): ContextFilter[] {
  const out: ContextFilter[] = []
  if (spec.rowValue !== undefined) out.push({ column: spec.rowField, values: [spec.rowValue] })
  if (spec.colValue !== undefined) out.push({ column: spec.colField, values: [spec.colValue] })
  const slicerHidden = spec.slicerField === spec.rowField || spec.slicerField === spec.colField
  if (!slicerHidden && spec.slicerValues.length > 0) {
    out.push({ column: spec.slicerField, values: spec.slicerValues })
  }
  return out
}

function literal(v: Value): string {
  if (v === null) return 'BLANK()'
  if (typeof v === 'string') return `"${v.replace(/"/g, '""')}"`
  if (typeof v === 'boolean') return v ? 'TRUE()' : 'FALSE()'
  return String(v)
}

/** Predicado DAX de un filtro: `Tabla[Col] = "x"` o `Tabla[Col] IN {"x", "y"}`. */
export function filterPredicate(f: ContextFilter): string {
  if (f.values.length === 1) return `${f.column} = ${literal(f.values[0])}`
  return `${f.column} IN {${f.values.map(literal).join(', ')}}`
}

/** Formula que reproduce el valor de una celda en el reproductor. */
export function playerFormula(measure: string, filters: ContextFilter[]): string {
  if (filters.length === 0) return measure
  return `CALCULATE(${measure}, ${filters.map(filterPredicate).join(', ')})`
}

/** Formula del reproductor para una columna calculada. */
export function columnFormula(table: string, name: string, expression: string): string {
  return `ADDCOLUMNS(${table}, "${name}", ${expression})`
}

/** Frase que lee una celda en palabras. */
export function cellSentence(measureLabel: string, filters: ContextFilter[]): string {
  if (filters.length === 0) return `${measureLabel} de todas las filas, sin ningún filtro.`
  const parts = filters.map((f) => {
    const col = parseColumn(f.column).column
    return f.values.length === 1 ? `${col} es ${plain(f.values[0])}` : `${col} es ${f.values.map(plain).join(' o ')}`
  })
  return `${measureLabel} solo de las filas donde ${parts.join(' y ')}.`
}

function plain(v: Value): string {
  return v === null ? 'vacío' : String(v)
}

/**
 * Sustituye las columnas de la fila actual en una expresion simple de nivel de fila.
 * Devuelve null si la expresion contiene llamadas a funciones.
 */
export function substituteRow(expression: string, model: DataModel, table: string, rowIndex: number): string | null {
  if (expression.includes('(')) return null
  const t = model.tables.find((x) => x.name === table)
  const row = t?.rows[rowIndex]
  if (!t || !row) return null
  return expression.replace(/([\p{L}_][\p{L}\p{N}_]*)\[([^\]]+)\]/gu, (whole, tn: string, cn: string) => {
    if (tn !== table) return whole
    const i = t.columns.findIndex((c) => c.name === cn)
    return i < 0 ? whole : literal(row[i])
  })
}

/** Indice de la fila del lado uno relacionada con una fila del lado muchos (relacion activa). */
export function relatedRowIndex(model: DataModel, fromTable: string, rowIndex: number, toTable: string): number | null {
  const rel = model.relationships.find((r) => r.active && r.fromTable === fromTable && r.toTable === toTable)
  const from = model.tables.find((t) => t.name === fromTable)
  const to = model.tables.find((t) => t.name === toTable)
  if (!rel || !from || !to) return null
  const fi = from.columns.findIndex((c) => c.name === rel.fromColumn)
  const ti = to.columns.findIndex((c) => c.name === rel.toColumn)
  const key = from.rows[rowIndex]?.[fi]
  const found = to.rows.findIndex((r) => r[ti] === key)
  return found < 0 ? null : found
}

/** Relacion activa entre una dimension y una tabla de hechos. */
export function relationBetween(model: DataModel, dimension: string, fact: string) {
  return model.relationships.find((r) => r.active && r.toTable === dimension && r.fromTable === fact) ?? null
}

export function isDimension(model: DataModel, table: string): boolean {
  return model.relationships.some((r) => r.toTable === table)
}

export interface MeasurePreset {
  id: string
  formula: string
  /** Descripcion breve para la frase en palabras. */
  label: string
  /** Columnas que lee la medida. */
  columns: string[]
}

export const MEASURES: MeasurePreset[] = [
  { id: 'ventas', formula: 'SUM(Ventas[Cantidad])', label: 'La cantidad vendida', columns: ['Ventas[Cantidad]'] },
  {
    id: 'devoluciones',
    formula: 'SUM(Devoluciones[Cantidad])',
    label: 'La cantidad devuelta',
    columns: ['Devoluciones[Cantidad]'],
  },
  { id: 'filas', formula: 'COUNTROWS(Ventas)', label: 'El número de ventas', columns: [] },
  {
    id: 'neto',
    formula: 'SUM(Ventas[Cantidad]) - SUM(Devoluciones[Cantidad])',
    label: 'La cantidad vendida menos la devuelta',
    columns: ['Ventas[Cantidad]', 'Devoluciones[Cantidad]'],
  },
]

/** Tablas de hechos que lee una medida (las nombradas en su formula). */
export function tablesRead(formula: string, model: DataModel): string[] {
  return model.tables.map((t) => t.name).filter((n) => new RegExp(`\\b${n}\\b`).test(formula))
}

export const FIELD_OPTIONS = [
  'Productos[Proveedor]',
  'Productos[Marca]',
  'Ventas[Ciudad]',
  'Ventas[Categoria]',
  'Calendario[NombreMes]',
]

export const SLICER_FIELD = 'Ventas[Ciudad]'
