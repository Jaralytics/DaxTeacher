import type { DataModel, DaxError, FilterEntry, Value } from './types'
import { EngineError } from './errors'
import { parse } from './parser'
import { Runner } from './evaluator'

// Evaluacion directa (sin traza) de una formula bajo un contexto dado. La usa la
// vista "Contextos" para mostrar que filas ve DAX y que valor resulta.

/** Filtro inicial sobre una columna calificada, p. ej. `Calendario[NombreMes]`. */
export interface ContextFilter {
  column: string
  values: Value[]
}

/** Fila actual de una tabla del modelo (contexto de fila inicial). */
export interface ContextRow {
  table: string
  /** Indice de la fila en `Table.rows`. */
  rowIndex: number
}

export interface ProbeOptions {
  filters?: ContextFilter[]
  row?: ContextRow
}

export interface ProbeSuccess {
  ok: true
  /** Valor escalar del resultado; null si es BLANK o si la formula devuelve una tabla. */
  value: Value
  /**
   * Por cada tabla del modelo, indices de las filas visibles bajo `filters`
   * (contexto de filtro externo, incluida la propagacion por relaciones activas).
   */
  visibleRows: Record<string, number[]>
  /**
   * Por cada tabla del modelo que la formula leyo, indices de las filas visibles
   * en la ultima lectura (agregador, iterador o referencia de tabla). Difiere de
   * `visibleRows` cuando la formula cambia el contexto, p. ej. con CALCULATE.
   */
  scannedRows: Record<string, number[]>
  /** Contexto de filtro vigente en esa ultima lectura (todos con origin 'existing'). */
  innerFilterContext: FilterEntry[]
  /** Hubo transicion de contexto durante la evaluacion. */
  contextTransition: boolean
}

export type ProbeResult = ProbeSuccess | { ok: false; error: DaxError }

/** Evalua `formula` con los filtros y la fila actual indicados. */
export function probe(formula: string, model: DataModel, options: ProbeOptions = {}): ProbeResult {
  try {
    const ast = parse(formula)
    const r = new Runner(formula, model).probe(ast, options.filters ?? [], options.row)
    return { ok: true, ...r }
  } catch (e) {
    if (e instanceof EngineError) return { ok: false, error: { message: e.message, span: e.span } }
    return { ok: false, error: { message: 'Ocurrió un error inesperado al evaluar la fórmula.', span: null } }
  }
}
