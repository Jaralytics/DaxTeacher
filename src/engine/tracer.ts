import type {
  FilterEntry,
  FilterOrigin,
  RowContextEntry,
  RowStatus,
  SnapshotColumn,
  SnapshotRow,
  TableRole,
  TableSnapshot,
} from './types'
import type { Ctx, Filter, TableValue } from './values'
import { qual } from './values'

export interface SnapOpts {
  role: TableRole
  title?: string
  status?: RowStatus[]
  notes?: (string | undefined)[]
  /** Nombres de columna en minusculas a resaltar. */
  highlight?: Set<string>
}

export function snapshotTable(t: TableValue, o: SnapOpts): TableSnapshot {
  const columns: SnapshotColumn[] = t.cols.map((c) => {
    const col: SnapshotColumn = { name: c.name }
    if (o.highlight?.has(c.name.toLowerCase())) col.highlight = true
    if (c.isNew) col.isNew = true
    if (c.type) col.type = c.type
    return col
  })
  const rows: SnapshotRow[] = t.rows.map((r, i) => {
    const row: SnapshotRow = { key: r.key, cells: [...r.cells], status: o.status?.[i] ?? 'normal' }
    const note = o.notes?.[i]
    if (note) row.note = note
    return row
  })
  return { id: t.id, title: o.title ?? t.title, role: o.role, columns, rows }
}

export function toEntry(f: Filter, origin: FilterOrigin): FilterEntry {
  return { id: f.id, columns: f.cols.map(qual), rows: f.rows.map((r) => [...r]), origin }
}

export function existingEntries(filters: Filter[]): FilterEntry[] {
  return filters.map((f) => toEntry(f, 'existing'))
}

const changed = (a: Filter, b: Filter): boolean => a.cols.length !== b.cols.length || a.rows.length !== b.rows.length

/**
 * Compara el contexto antes y despues de un paso y marca que cambio.
 * `hide` son filtros reemplazados que no se muestran tachados.
 */
export function diffEntries(
  before: Filter[],
  after: Filter[],
  newOrigins: Map<string, FilterOrigin>,
  hide: Set<string>,
): FilterEntry[] {
  const afterById = new Map(after.map((f) => [f.id, f]))
  const beforeIds = new Set(before.map((f) => f.id))
  const out: FilterEntry[] = []
  for (const b of before) {
    const a = afterById.get(b.id)
    if (!a) {
      if (!hide.has(b.id)) out.push(toEntry(b, 'removed'))
    } else if (changed(a, b)) {
      out.push(toEntry(a, 'replaced'))
    } else {
      out.push(toEntry(a, 'existing'))
    }
  }
  for (const a of after) {
    if (!beforeIds.has(a.id)) out.push(toEntry(a, newOrigins.get(a.id) ?? 'added'))
  }
  return out
}

export function rowContextEntries(ctx: Ctx): RowContextEntry[] {
  return ctx.rows.map((rc) => ({
    table: rc.table.model ?? rc.table.title,
    values: rc.table.cols.map((c, i) => ({ column: c.name, value: rc.row.cells[i] })),
  }))
}
