import type { DataModel, RunResult } from './types'
import { EngineError } from './errors'
import { parse } from './parser'
import { Runner } from './evaluator'

export type * from './types'
export * from './probe'

/** Evalua una formula DAX sobre el modelo y devuelve la traza paso a paso. */
export function run(formula: string, model: DataModel): RunResult {
  try {
    const ast = parse(formula)
    const trace = new Runner(formula, model).execute(ast)
    return { ok: true, trace }
  } catch (e) {
    if (e instanceof EngineError) return { ok: false, error: { message: e.message, span: e.span } }
    return { ok: false, error: { message: 'Ocurrió un error inesperado al evaluar la fórmula.', span: null } }
  }
}
