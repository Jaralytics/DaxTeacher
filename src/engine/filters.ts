import type { DataModel, Table, Value } from './types'
import { isIsoDate, normKey, plain, qual, tupleKey } from './values'
import type { FCol, Filter, RelDef } from './values'

/** Indices de las filas de la tabla del modelo que cumplen todos los filtros que la tocan. */
export function visibleRows(tbl: Table, filters: Filter[]): number[] {
  const checks: { idxs: number[]; allowed: Set<string> }[] = []
  for (const f of filters) {
    const pos: number[] = []
    const fidx: number[] = []
    f.cols.forEach((c, k) => {
      if (c.table !== tbl.name) return
      const ci = tbl.columns.findIndex((x) => x.name === c.column)
      if (ci >= 0) {
        pos.push(ci)
        fidx.push(k)
      }
    })
    if (pos.length === 0) continue
    const allowed = new Set(f.rows.map((r) => tupleKey(fidx.map((k) => r[k]))))
    checks.push({ idxs: pos, allowed })
  }
  const out: number[] = []
  tbl.rows.forEach((row, i) => {
    if (checks.every((c) => c.allowed.has(tupleKey(c.idxs.map((k) => row[k]))))) out.push(i)
  })
  return out
}

export interface DropResult {
  after: Filter[]
  removed: Set<string>
  modified: Set<string>
}

/**
 * Quita de los filtros las columnas que cumplan `drop`. Un filtro que se queda sin columnas
 * desaparece; uno que conserva algunas se proyecta (sin duplicados) sobre las restantes.
 */
export function dropColumns(filters: Filter[], drop: (c: FCol) => boolean, protect: Set<string>): DropResult {
  const after: Filter[] = []
  const removed = new Set<string>()
  const modified = new Set<string>()
  for (const f of filters) {
    if (protect.has(f.id)) {
      after.push(f)
      continue
    }
    const keep = f.cols.map((c, i) => (drop(c) ? -1 : i)).filter((i) => i >= 0)
    if (keep.length === f.cols.length) {
      after.push(f)
    } else if (keep.length === 0) {
      removed.add(f.id)
    } else {
      const seen = new Set<string>()
      const rows: Value[][] = []
      for (const r of f.rows) {
        const proj = keep.map((i) => r[i])
        const k = tupleKey(proj)
        if (!seen.has(k)) {
          seen.add(k)
          rows.push(proj)
        }
      }
      after.push({ id: f.id, cols: keep.map((i) => f.cols[i]), rows })
      modified.add(f.id)
    }
  }
  return { after, removed, modified }
}

/** Descripcion corta de un filtro para las explicaciones. */
export function describeFilter(f: Filter): string {
  const names = f.cols.map(qual)
  if (f.rows.length === 1) {
    return names.map((n, i) => `${n} = ${show(f.rows[0][i])}`).join(', ')
  }
  const shown = f.rows.slice(0, 4).map((r) => (r.length === 1 ? show(r[0]) : '(' + r.map(show).join(', ') + ')'))
  const more = f.rows.length > 4 ? ', ...' : ''
  return `${names.join(', ')} en {${shown.join(', ')}${more}}`
}

function show(v: Value): string {
  return typeof v === 'string' && !isIsoDate(v) ? `"${v}"` : plain(v)
}

/** Hay un filtro directo sobre la tabla, o llega uno por una relacion activa desde su lado uno. */
export function isFiltered(name: string, filters: Filter[], rels: RelDef[], active: boolean[], seen: Set<string> = new Set()): boolean {
  if (seen.has(name)) return false
  if (filters.some((f) => f.cols.some((c) => c.table === name))) return true
  const s2 = new Set(seen).add(name)
  return rels.some((r, i) => active[i] && r.fromTable === name && isFiltered(r.toTable, filters, rels, active, s2))
}

/** Indices de las relaciones activas por las que un filtro llega a la tabla (desde su lado uno). */
export function propagatingRels(name: string, filters: Filter[], rels: RelDef[], active: boolean[]): number[] {
  const out: number[] = []
  rels.forEach((r, i) => {
    if (active[i] && r.fromTable === name && isFiltered(r.toTable, filters, rels, active, new Set([name]))) out.push(i)
  })
  return out
}

/** Filas visibles de una tabla: filtros directos mas los que llegan por relaciones activas. */
export function visibleRowsRel(
  model: DataModel,
  name: string,
  filters: Filter[],
  rels: RelDef[],
  active: boolean[],
  seen: Set<string> = new Set(),
): number[] {
  const tbl = model.tables.find((t) => t.name === name) as Table
  let idxs = visibleRows(tbl, filters)
  if (seen.has(name)) return idxs
  const s2 = new Set(seen).add(name)
  for (const i of propagatingRels(name, filters, rels, active)) {
    const r = rels[i]
    const one = model.tables.find((t) => t.name === r.toTable) as Table
    const oneIdx = visibleRowsRel(model, r.toTable, filters, rels, active, s2)
    const tc = one.columns.findIndex((c) => c.name === r.toColumn)
    const fc = tbl.columns.findIndex((c) => c.name === r.fromColumn)
    const keys = new Set(oneIdx.map((k) => normKey(one.rows[k][tc])))
    idxs = idxs.filter((k) => keys.has(normKey(tbl.rows[k][fc])))
  }
  return idxs
}
