// Contrato compartido entre el motor DAX (src/engine) y la interfaz (src/ui).
// El motor evalua una formula y devuelve una traza: una lista ordenada de pasos,
// cada uno con una foto completa de lo que se debe mostrar en pantalla.

/** Valor escalar de DAX. null representa BLANK. */
export type Value = number | string | boolean | null

/** Las fechas ('date') se guardan como texto ISO `AAAA-MM-DD`. */
export type ColumnType = 'number' | 'string' | 'boolean' | 'date'

export interface Column {
  name: string
  type: ColumnType
}

export interface Table {
  name: string
  columns: Column[]
  rows: Value[][]
}

/**
 * Relacion muchos a uno (from = lado muchos, to = lado uno). El filtro viaja del
 * lado uno al lado muchos. Entre dos tablas solo una relacion puede estar activa.
 */
export interface Relationship {
  fromTable: string
  fromColumn: string
  toTable: string
  toColumn: string
  active: boolean
}

export interface DataModel {
  tables: Table[]
  relationships: Relationship[]
}

/** Rango [start, end) de caracteres dentro del texto de la formula. */
export interface SourceSpan {
  start: number
  end: number
}

export type RowStatus =
  | 'normal'
  /** Fila que se esta evaluando en este paso (contexto de fila actual). */
  | 'active'
  /** Fila que ya paso la condicion. */
  | 'kept'
  /** Fila descartada; se sigue mostrando, atenuada, hasta que el motor la quite. */
  | 'removed'
  /** Fila nueva respecto al paso anterior. */
  | 'added'

export type TableRole = 'source' | 'working' | 'filter' | 'result'

export interface SnapshotColumn {
  name: string
  /** Tipo de dato, para dar formato (las fechas llegan como texto ISO). */
  type?: ColumnType
  /** Columna involucrada en la operacion del paso actual. */
  highlight?: boolean
  /** Columna creada por la formula (ADDCOLUMNS, SELECTCOLUMNS). */
  isNew?: boolean
}

export interface SnapshotRow {
  /** Identidad estable de la fila entre pasos, para poder animar. */
  key: string
  cells: Value[]
  status: RowStatus
  /** Texto corto junto a la fila, p. ej. `5 = 5 -> VERDADERO`. */
  note?: string
}

export interface TableSnapshot {
  /** Identidad estable de la tabla entre pasos, para poder animar. */
  id: string
  title: string
  role: TableRole
  columns: SnapshotColumn[]
  rows: SnapshotRow[]
}

export type FilterOrigin =
  /** Ya existia antes de este paso. */
  | 'existing'
  /** Agregado en este paso. */
  | 'added'
  /** Reemplaza a un filtro anterior sobre las mismas columnas. */
  | 'replaced'
  /** Quitado en este paso (se muestra tachado). */
  | 'removed'

/** Un filtro del contexto de filtro: combinaciones permitidas para un grupo de columnas. */
export interface FilterEntry {
  id: string
  /** Columnas calificadas, p. ej. `Ventas[Producto]`. */
  columns: string[]
  rows: Value[][]
  origin: FilterOrigin
}

/** Una fila que se esta iterando (contexto de fila). */
export interface RowContextEntry {
  table: string
  values: { column: string; value: Value }[]
}

export type RelationshipStatus =
  | 'active'
  | 'inactive'
  /** Activada en este paso (USERELATIONSHIP). */
  | 'activated'
  /** Desactivada en este paso porque otra relacion tomo su lugar. */
  | 'deactivated'

/** Estado de una relacion del modelo en un paso. */
export interface RelationshipState {
  /** Columna calificada del lado muchos, p. ej. `Ventas[FechaVenta]`. */
  from: string
  /** Columna calificada del lado uno, p. ej. `Calendario[Fecha]`. */
  to: string
  status: RelationshipStatus
  /** El paso actual usa esta relacion (propagacion de filtros, RELATED). */
  used?: boolean
}

/** Resultado parcial de una subexpresion, p. ej. `SUM(Ventas[Cantidad])` = 38. */
export interface PartialResult {
  label: string
  value: Value
  span: SourceSpan
  /** Tabla del modelo de la que salio el valor, si viene de una sola. */
  sourceTable?: string
}

export type StepKind =
  | 'start'
  | 'enter'
  | 'rewrite'
  | 'iterate-row'
  | 'table-result'
  | 'context-transition'
  | 'context-change'
  | 'apply-filters'
  /** Un filtro viaja de una tabla a otra por una relacion. */
  | 'propagate'
  /** Cambia que relaciones estan activas (USERELATIONSHIP). */
  | 'relationship-change'
  | 'aggregate'
  /** Dos o mas resultados parciales se combinan en uno (operador, IF, DIVIDE...). */
  | 'combine'
  | 'scalar-result'
  | 'result'

export interface TraceStep {
  kind: StepKind
  /** 'minor' = pasos fila por fila que el reproductor puede omitir. */
  detail: 'major' | 'minor'
  title: string
  /** Explicacion en espanol. Admite `codigo` entre backticks. */
  explanation: string
  /** Parte de la formula que se esta evaluando. */
  span: SourceSpan | null
  /** Tablas a mostrar en el escenario, en orden. */
  tables: TableSnapshot[]
  filterContext: FilterEntry[]
  /** De la mas externa a la mas interna. */
  rowContext: RowContextEntry[]
  /** Todas las relaciones del modelo con su estado en este paso. */
  relationships: RelationshipState[]
  /**
   * Resultados escalares ya calculados que esperan a ser combinados, en el orden
   * en que aparecen en la formula. Se mantienen en pantalla hasta el paso 'combine'.
   */
  partials?: PartialResult[]
  /** Resultado escalar parcial o final de este paso. */
  scalar?: { label: string; value: Value }
}

export type TraceResult =
  | { kind: 'table'; table: TableSnapshot }
  | { kind: 'scalar'; value: Value }

export interface Trace {
  formula: string
  steps: TraceStep[]
  result: TraceResult
}

export interface DaxError {
  message: string
  span: SourceSpan | null
}

export type RunResult = { ok: true; trace: Trace } | { ok: false; error: DaxError }

export interface Example {
  id: string
  title: string
  /** Funcion o concepto principal, para agrupar en el menu. */
  topic: string
  description: string
  formula: string
}
