import type { ColumnType, SourceSpan, Value } from './types'
import { EngineError } from './errors'

export interface Lineage {
  table: string
  column: string
}

export interface TCol {
  name: string
  lineage: Lineage | null
  isNew?: boolean
  type?: ColumnType
}

export interface TRow {
  key: string
  cells: Value[]
}

/** Tabla interna: del modelo o derivada de una funcion de tabla. */
export interface TableValue {
  id: string
  title: string
  /** Nombre de la tabla del modelo si procede directamente de una (rol 'source'). */
  model: string | null
  cols: TCol[]
  rows: TRow[]
}

/** Columna del modelo con nombres canonicos. */
export interface FCol {
  table: string
  column: string
}

export interface Filter {
  id: string
  cols: FCol[]
  rows: Value[][]
}

export interface RowCtx {
  table: TableValue
  row: TRow
}

export interface Ctx {
  filters: Filter[]
  rows: RowCtx[]
  /** Relaciones activas en esta evaluacion, en el orden de model.relationships. */
  active: boolean[]
}

/** Relacion con nombres canonicos (from = lado muchos). */
export interface RelDef {
  fromTable: string
  fromColumn: string
  toTable: string
  toColumn: string
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

export const isIsoDate = (v: Value): boolean => typeof v === 'string' && ISO_DATE.test(v)

/** AAAA-MM-DD -> dd/mm/aaaa */
export function showDate(v: string): string {
  const m = ISO_DATE.exec(v)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : v
}

export function inferType(vals: Value[]): ColumnType | undefined {
  const v = vals.find((x) => x !== null)
  if (v === undefined) return undefined
  if (typeof v === 'number') return 'number'
  if (typeof v === 'boolean') return 'boolean'
  return isIsoDate(v) ? 'date' : 'string'
}

export const qual = (c: FCol): string => `${c.table}[${c.column}]`

export function normKey(v: Value): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return 's:' + v.toLowerCase()
  if (typeof v === 'number') return 'n:' + v
  return 'b:' + v
}

export const tupleKey = (vs: Value[]): string => vs.map(normKey).join('\u0001')

/** Texto de un valor para notas y explicaciones. */
export function fmt(v: Value): string {
  if (v === null) return 'BLANK()'
  if (typeof v === 'string' && isIsoDate(v)) return showDate(v)
  if (typeof v === 'string') return `"${v.replace(/"/g, '""')}"`
  if (typeof v === 'boolean') return v ? 'VERDADERO' : 'FALSO'
  return String(v)
}

/** Texto de un valor sin comillas, para listas de valores. */
export function plain(v: Value): string {
  return typeof v === 'string' ? (isIsoDate(v) ? showDate(v) : v) : fmt(v)
}

export const round = (x: number): number => Math.round(x * 1e10) / 1e10

export function toNum(v: Value, span: SourceSpan | null): number {
  if (v === null) return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  const x = Number(v)
  if (v.trim() === '' || Number.isNaN(x)) {
    throw new EngineError(`No se puede convertir el texto "${v}" a número.`, span)
  }
  return x
}

export function toBool(v: Value, span: SourceSpan | null): boolean {
  if (v === null) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  throw new EngineError('Se esperaba un valor VERDADERO o FALSO pero se obtuvo un texto.', span)
}

export function toText(v: Value): string {
  if (v === null) return ''
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return String(v)
}

function defaultFor(v: Value): Value {
  if (typeof v === 'number') return 0
  if (typeof v === 'string') return ''
  return false
}

/** Compara dos valores; BLANK se trata como 0, vacio o FALSO y el texto no distingue mayusculas. */
export function compareValues(a: Value, b: Value): number {
  let x = a
  let y = b
  if (x === null && y === null) return 0
  if (x === null) x = defaultFor(y)
  if (y === null) y = defaultFor(x)
  if (typeof x === 'number' && typeof y === 'number') return x === y ? 0 : x < y ? -1 : 1
  if (typeof x === 'boolean' && typeof y === 'boolean') return Number(x) - Number(y)
  const sx = String(x).toLowerCase()
  const sy = String(y).toLowerCase()
  return sx === sy ? 0 : sx < sy ? -1 : 1
}
