import type {
  ColumnType,
  DataModel,
  FilterEntry,
  FilterOrigin,
  PartialResult,
  RowStatus,
  SourceSpan,
  StepKind,
  RelationshipState,
  RelationshipStatus,
  Table,
  TableRole,
  TableSnapshot,
  Trace,
  TraceStep,
  Value,
} from './types'
import { EngineError } from './errors'
import { AGG_COLUMN, ITERATORS, ROW_LEVEL, TABLE_FUNCS, walk } from './parser'
import type { CallNode, ColRefNode, Node } from './parser'
import { describeFilter, dropColumns, propagatingRels, visibleRowsRel } from './filters'
import { diffEntries, existingEntries, rowContextEntries, snapshotTable } from './tracer'
import {
  compareValues,
  fmt,
  inferType,
  normKey,
  plain,
  qual,
  round,
  toBool,
  toNum,
  toText,
  tupleKey,
} from './values'
import type { Ctx, FCol, Filter, RelDef, TableValue } from './values'

const MAX_STEPS = 2000

interface StepInput {
  kind: StepKind
  detail?: 'major' | 'minor'
  title: string
  explanation: string
  span: SourceSpan | null
  tables: TableSnapshot[]
  scalar?: { label: string; value: Value }
  filters?: FilterEntry[]
  /** Relaciones que se activan o desactivan en este paso. */
  relChange?: Map<number, 'activated' | 'deactivated'>
  /** Indices de las relaciones que usa este paso. */
  used?: number[]
}

interface ReadRec {
  table: string
  idxs: number[]
  col: string | null
}

interface Decision {
  note: string
  status: RowStatus
  explanation: string
}

interface LoopSpec {
  exprs: Node[]
  role: TableRole
  newCols?: string[]
  intro: (i: number, n: number) => string
  decide: (vals: Value[], i: number, rctx: Ctx) => Decision
}

interface FSpec {
  kind: 'modifier' | 'table' | 'predicate' | 'userel'
  node: Node
  keep: boolean
}

interface ModSpec {
  call: CallNode
  drop: (c: FCol) => boolean
  what: string
}


const hasNested = (n: Node): boolean => {
  let found = false
  walk(n, (x) => {
    if (x.type === 'call' && !ROW_LEVEL.has(x.name)) found = true
  })
  return found
}

const OP_WORDS: Record<string, string> = {
  '+': 'se suman',
  '-': 'se restan',
  '*': 'se multiplican',
  '/': 'se dividen',
  '&': 'se concatenan',
  '=': 'se comparan',
  '==': 'se comparan',
  '<>': 'se comparan',
  '<': 'se comparan',
  '<=': 'se comparan',
  '>': 'se comparan',
  '>=': 'se comparan',
  '&&': 'se evalúan con Y',
  '||': 'se evalúan con O',
}

const verb: Record<string, string> = {
  SUM: 'suma',
  AVERAGE: 'promedia',
  MIN: 'toma el mínimo de',
  MAX: 'toma el máximo de',
  COUNT: 'cuenta los valores no vacíos de',
  DISTINCTCOUNT: 'cuenta los valores distintos de',
}

function aggregate(fn: string, vals: Value[]): Value {
  if (vals.length === 0) return null
  const nums = vals.filter((v): v is number => typeof v === 'number')
  switch (fn) {
    case 'SUM':
    case 'SUMX':
      return nums.length === 0 ? null : round(nums.reduce((a, b) => a + b, 0))
    case 'AVERAGE':
    case 'AVERAGEX':
      return nums.length === 0 ? null : round(nums.reduce((a, b) => a + b, 0) / nums.length)
    case 'MIN':
    case 'MINX':
      return nums.length === 0 ? extremum(vals, -1) : Math.min(...nums)
    case 'MAX':
    case 'MAXX':
      return nums.length === 0 ? extremum(vals, 1) : Math.max(...nums)
    case 'COUNT':
    case 'COUNTX':
      return vals.filter((v) => v !== null).length
    default:
      return new Set(vals.filter((v) => v !== null).map(normKey)).size
  }
}

/** Minimo (dir -1) o maximo (dir 1) de valores de texto, como las fechas. */
function extremum(vals: Value[], dir: number): Value {
  const ss = vals.filter((v): v is string => typeof v === 'string')
  if (ss.length === 0) return null
  return ss.reduce((a, b) => (compareValues(a, b) * dir >= 0 ? a : b))
}

function sumList(vals: Value[], fn: string): string {
  const nums = vals.filter((v): v is number => typeof v === 'number')
  if (fn.startsWith('SUM') && nums.length > 1 && nums.length <= 8) return nums.join(' + ') + ' = '
  return ''
}

function pl(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

export class Runner {
  readonly steps: TraceStep[] = []
  private uid = 0
  private pins: { snap: () => TableSnapshot }[] = []
  private landing: { node: Node; value: Value } | null = null
  private sources: string[] = []
  private readonly src: string
  private readonly model: DataModel
  private readonly rels: RelDef[]
  private readonly baseActive: boolean[]
  private relatedShown = new Set<number>()
  private quiet = false
  private reads = new Map<string, number[]>()
  private lastReadFilters: Filter[] = []
  private transitioned = false
  private partials: PartialResult[] = []
  private focus: Set<string>[] = []
  private readLog: ReadRec[] = []

  constructor(src: string, model: DataModel) {
    this.src = src
    this.model = model
    this.rels = model.relationships.map((r) => ({
      fromTable: r.fromTable,
      fromColumn: r.fromColumn,
      toTable: r.toTable,
      toColumn: r.toColumn,
    }))
    this.baseActive = model.relationships.map((r) => r.active)
  }

  // ---------- entrada ----------

  execute(root: Node): Trace {
    const EMPTY: Ctx = { filters: [], rows: [], active: this.baseActive }
    this.validate(root)
    this.sources = this.collectSources(root)
    const names = this.sources.length > 0 ? this.sources.join(', ') : 'ninguna'
    this.emit(EMPTY, {
      kind: 'start',
      detail: 'major',
      title: 'Punto de partida',
      explanation: `Vamos a ver paso a paso qué hace DAX con esta fórmula. Tablas del modelo que usa: ${names}. Al empezar no hay filtros ni filas en curso: los dos contextos están vacíos.`,
      span: root.span,
      tables: this.stage([]),
    })
    if (this.isTableNode(root)) {
      const t = this.evalTable(root, EMPTY)
      const snap = snapshotTable(t, { role: 'result', title: 'Resultado' })
      this.emit(EMPTY, {
        kind: 'result',
        detail: 'major',
        title: 'Resultado',
        explanation: `La fórmula devuelve una tabla con ${pl(t.rows.length, 'fila', 'filas')}.`,
        span: root.span,
        tables: [snap],
      })
      return { formula: this.src, steps: this.steps, result: { kind: 'table', table: snap } }
    }
    const value = this.evalScalar(root, EMPTY)
    this.emit(EMPTY, {
      kind: 'result',
      detail: 'major',
      title: 'Resultado',
      explanation: `La fórmula devuelve un único valor: ${fmt(value)}.`,
      span: root.span,
      tables: this.stage([]),
      scalar: { label: 'Resultado', value },
    })
    return { formula: this.src, steps: this.steps, result: { kind: 'scalar', value } }
  }

  // ---------- evaluacion directa sin traza ----------

  /** Evalua sin generar pasos bajo un contexto inicial; lo usa probe(). */
  probe(
    root: Node,
    filters: { column: string; values: Value[] }[],
    row: { table: string; rowIndex: number } | undefined,
  ): {
    value: Value
    visibleRows: Record<string, number[]>
    scannedRows: Record<string, number[]>
    innerFilterContext: FilterEntry[]
    contextTransition: boolean
  } {
    this.quiet = true
    this.validate(root)
    const fs: Filter[] = filters.map((f, i) => {
      const m = /^\s*'?([^'[\]]+?)'?\s*\[(.+)\]\s*$/.exec(f.column)
      if (!m) throw new EngineError(`La columna '${f.column}' no tiene el formato Tabla[Columna].`, null)
      const t = this.model.tables.find((x) => x.name.toLowerCase() === m[1].toLowerCase())
      const c = t?.columns.find((x) => x.name.toLowerCase() === m[2].toLowerCase())
      if (!t || !c) throw new EngineError(`La columna '${f.column}' no existe en el modelo.`, null)
      return { id: `P${i + 1}`, cols: [{ table: t.name, column: c.name }], rows: f.values.map((v) => [v]) }
    })
    const rowsCtx: Ctx['rows'] = []
    if (row) {
      const t = this.model.tables.find((x) => x.name.toLowerCase() === row.table.toLowerCase())
      if (!t) throw new EngineError(`La tabla '${row.table}' no existe en el modelo.`, null)
      if (!Number.isInteger(row.rowIndex) || row.rowIndex < 0 || row.rowIndex >= t.rows.length) {
        throw new EngineError(`La fila ${row.rowIndex} no existe en la tabla ${t.name}.`, null)
      }
      const tv = this.modelTableValue(t, [row.rowIndex])
      rowsCtx.push({ table: tv, row: tv.rows[0] })
    }
    const ctx: Ctx = { filters: fs, rows: rowsCtx, active: this.baseActive }
    const value = this.isTableNode(root) ? (this.evalTable(root, ctx), null) : this.evalScalar(root, ctx)
    const visibleRows: Record<string, number[]> = {}
    for (const t of this.model.tables) visibleRows[t.name] = this.visIdx(t, { filters: fs, rows: [], active: this.baseActive })
    const scannedRows: Record<string, number[]> = {}
    for (const [k, v] of this.reads) scannedRows[k] = v
    return {
      value,
      visibleRows,
      scannedRows,
      innerFilterContext: this.reads.size > 0 ? existingEntries(this.lastReadFilters) : [],
      contextTransition: this.transitioned,
    }
  }

  // ---------- utilidades ----------

  private text(span: SourceSpan, max = Infinity): string {
    const t = this.src.slice(span.start, span.end).replace(/\s+/g, ' ').trim()
    return t.length > max ? t.slice(0, max - 3) + '...' : t
  }

  private newId(prefix: string): string {
    this.uid++
    return `${prefix}${this.uid}`
  }

  private findTable(name: string, span: SourceSpan): Table {
    const t = this.model.tables.find((x) => x.name.toLowerCase() === name.toLowerCase())
    if (!t) throw new EngineError(`La tabla '${name}' no existe en el modelo.`, span)
    return t
  }

  private tableByName(name: string): Table {
    return this.model.tables.find((x) => x.name === name) as Table
  }

  private colIndex(t: Table, name: string, span: SourceSpan): number {
    const i = t.columns.findIndex((c) => c.name.toLowerCase() === name.toLowerCase())
    if (i < 0) throw new EngineError(`La columna '${name}' no existe en la tabla ${t.name}.`, span)
    return i
  }

  /** Columna del modelo a la que apunta una referencia (calificada o no). */
  private modelColumn(n: ColRefNode): { table: Table; ci: number } {
    if (n.table !== null) {
      const t = this.findTable(n.table, n.span)
      return { table: t, ci: this.colIndex(t, n.column, n.span) }
    }
    const matches = this.model.tables.filter((t) => t.columns.some((c) => c.name.toLowerCase() === n.column.toLowerCase()))
    if (matches.length === 0) throw new EngineError(`La columna [${n.column}] no existe en ninguna tabla del modelo.`, n.span)
    if (matches.length > 1) {
      throw new EngineError(`La columna [${n.column}] existe en varias tablas; indica de cuál con Tabla[${n.column}].`, n.span)
    }
    return { table: matches[0], ci: this.colIndex(matches[0], n.column, n.span) }
  }

  private modelTableValue(t: Table, idxs: number[]): TableValue {
    return {
      id: t.name,
      title: t.name,
      model: t.name,
      cols: t.columns.map((c) => ({ name: c.name, lineage: { table: t.name, column: c.name }, type: c.type })),
      rows: idxs.map((i) => ({ key: String(i), cells: t.rows[i] })),
    }
  }

  private allIdx(t: Table): number[] {
    return t.rows.map((_, i) => i)
  }

  private validate(root: Node): void {
    walk(root, (x) => {
      if (x.type === 'tableRef') this.findTable(x.name, x.span)
      else if (x.type === 'colRef' && x.table !== null) this.modelColumn(x)
    })
  }

  private collectSources(root: Node): string[] {
    const names: string[] = []
    const add = (n: string): void => {
      if (!names.includes(n)) names.push(n)
    }
    walk(root, (x) => {
      if (x.type === 'tableRef') add(this.findTable(x.name, x.span).name)
      else if (x.type === 'colRef') {
        if (x.table !== null) add(this.findTable(x.table, x.span).name)
        else {
          const m = this.model.tables.filter((t) => t.columns.some((c) => c.name.toLowerCase() === x.column.toLowerCase()))
          if (m.length === 1) add(m[0].name)
        }
      }
    })
    return names
  }

  private isTableNode(n: Node): boolean {
    return n.type === 'tableRef' || (n.type === 'call' && TABLE_FUNCS.has(n.name))
  }

  private refNames(nodes: Node[]): Set<string> {
    const s = new Set<string>()
    for (const e of nodes) {
      walk(e, (x) => {
        if (x.type === 'colRef') s.add(x.column.toLowerCase())
      })
    }
    return s
  }

  private arity(n: CallNode, min: number, max: number): void {
    if (n.args.length >= min && n.args.length <= max) return
    const exp = min === max ? `${min}` : max === Infinity ? `al menos ${min}` : `entre ${min} y ${max}`
    throw new EngineError(`La función ${n.name} espera ${exp} ${exp === '1' ? 'argumento' : 'argumentos'}.`, n.span)
  }

  // ---------- trazas ----------

  private emit(ctx: Ctx, s: StepInput): void {
    if (this.quiet) return
    if (this.steps.length >= MAX_STEPS) {
      throw new EngineError('La expresión genera demasiados pasos (más de 2000) para mostrarla. Prueba con una fórmula más simple.', null)
    }
    const step: TraceStep = {
      kind: s.kind,
      detail: s.detail ?? 'major',
      title: s.title,
      explanation: s.explanation,
      span: s.span,
      tables: s.tables,
      filterContext: s.filters ?? existingEntries(ctx.filters),
      rowContext: rowContextEntries(ctx),
      relationships: this.relStates(ctx, s),
    }
    if (s.scalar) step.scalar = s.scalar
    if (this.partials.length > 0) step.partials = this.partials.map((p) => ({ ...p }))
    this.steps.push(step)
  }

  private relStates(ctx: Ctx, s: StepInput): RelationshipState[] {
    return this.rels.map((r, i) => {
      const status: RelationshipStatus = s.relChange?.get(i) ?? (ctx.active[i] ? 'active' : 'inactive')
      const st: RelationshipState = { from: `${r.fromTable}[${r.fromColumn}]`, to: `${r.toTable}[${r.toColumn}]`, status }
      if (s.used?.includes(i)) st.used = true
      return st
    })
  }

  /** Tablas en escena: las del modelo, las tablas que se estan iterando (fijas) y las de trabajo (maximo 3). */
  private stage(extras: TableSnapshot[]): TableSnapshot[] {
    if (this.quiet) return []
    const pinSnaps: TableSnapshot[] = []
    this.pins.forEach((p, k) => {
      const sn = p.snap()
      if (pinSnaps.some((x) => x.id === sn.id)) sn.id = `${sn.id}#${k}`
      pinSnaps.push(sn)
    })
    const pinIds = new Set(pinSnaps.map((x) => x.id))
    const ex = extras.map((e) => (pinIds.has(e.id) ? { ...e, id: e.id + '#ctx' } : e))
    const ids = new Set([...pinIds, ...ex.map((e) => e.id)])
    const top = this.focus.length > 0 ? this.focus[this.focus.length - 1] : null
    const srcs = this.sources
      .filter((n) => !ids.has(n) && (top === null || top.has(n)))
      .map((n) => {
        const t = this.tableByName(n)
        return snapshotTable(this.modelTableValue(t, this.allIdx(t)), { role: 'source' })
      })
    const all = [...srcs, ...pinSnaps, ...ex]
    const seen = new Set<string>()
    const unique: TableSnapshot[] = []
    for (let i = all.length - 1; i >= 0; i--) {
      if (!seen.has(all[i].id)) {
        seen.add(all[i].id)
        unique.unshift(all[i])
      }
    }
    const inner = pinSnaps.length > 0 ? pinSnaps[pinSnaps.length - 1].id : null
    while (unique.length > 3) {
      const k = unique.findIndex((x) => x.id !== inner)
      unique.splice(k, 1)
    }
    return unique
  }

  /** Como stage, pero sin las tablas de origen de la formula: solo las que se pasan y las fijas. */
  private stageOnly(extras: TableSnapshot[]): TableSnapshot[] {
    this.focus.push(new Set())
    try {
      return this.stage(extras)
    } finally {
      this.focus.pop()
    }
  }

  private roleOf(t: TableValue): TableRole {
    return t.model !== null ? 'source' : 'working'
  }

  private visIdx(t: Table, ctx: Ctx): number[] {
    return visibleRowsRel(this.model, t.name, ctx.filters, this.rels, ctx.active)
  }

  /** Filas visibles de una tabla del modelo; muestra como llegan los filtros (directos y por relaciones). */
  private visibleTable(t: Table, ctx: Ctx, span: SourceSpan): TableValue {
    const idxs = this.visIdx(t, ctx)
    this.reads.set(t.name, idxs)
    this.lastReadFilters = ctx.filters
    this.explainVisibility(t, ctx, span)
    return this.modelTableValue(t, idxs)
  }

  private colPos(t: Table, name: string): number {
    return t.columns.findIndex((c) => c.name === name)
  }

  private explainVisibility(t: Table, ctx: Ctx, span: SourceSpan): void {
    const direct = ctx.filters.filter((f) => f.cols.some((c) => c.table === t.name))
    const props = propagatingRels(t.name, ctx.filters, this.rels, ctx.active)
    if (direct.length === 0 && props.length === 0) return
    const full = this.modelTableValue(t, this.allIdx(t))
    let acc = new Set(this.allIdx(t))
    for (const ri of props) {
      const r = this.rels[ri]
      const one = this.tableByName(r.toTable)
      this.explainVisibility(one, ctx, span)
      const oneIdx = this.visIdx(one, ctx)
      const oneSet = new Set(oneIdx)
      const tc = this.colPos(one, r.toColumn)
      const fc = this.colPos(t, r.fromColumn)
      const keyVals: Value[] = []
      const keySet = new Set<string>()
      for (const k of oneIdx) {
        const v = one.rows[k][tc]
        if (!keySet.has(normKey(v))) {
          keySet.add(normKey(v))
          keyVals.push(v)
        }
      }
      acc = new Set([...acc].filter((k) => keySet.has(normKey(t.rows[k][fc]))))
      const shown = keyVals.slice(0, 6).map((v) => plain(v)).join(', ') + (keyVals.length > 6 ? ', ...' : '')
      const oneFull = this.modelTableValue(one, this.allIdx(one))
      const fromQ = qual({ table: t.name, column: r.fromColumn })
      const toQ = qual({ table: one.name, column: r.toColumn })
      this.emit(ctx, {
        kind: 'propagate',
        detail: 'major',
        title: `El filtro viaja de ${one.name} a ${t.name}`,
        explanation: `La relación ${fromQ} -> ${toQ} lleva el filtro del lado uno (${one.name}) al lado muchos (${t.name}). ${keyVals.length === 1 ? 'Sobrevive este valor' : 'Sobreviven estos valores'} de ${toQ}: ${shown}. Por eso en ${t.name} ${acc.size === 1 ? 'queda' : 'quedan'} ${pl(acc.size, 'fila', 'filas')} de ${t.rows.length}.`,
        span,
        tables: this.stage([
          snapshotTable(oneFull, {
            role: 'source',
            highlight: new Set([r.toColumn.toLowerCase()]),
            status: oneFull.rows.map((_, i): RowStatus => (oneSet.has(i) ? 'kept' : 'removed')),
          }),
          snapshotTable(full, {
            role: 'source',
            highlight: new Set([r.fromColumn.toLowerCase()]),
            status: full.rows.map((_, i): RowStatus => (acc.has(i) ? 'kept' : 'removed')),
          }),
        ]),
        used: [ri],
      })
    }
    if (direct.length > 0) {
      const idxs = this.visIdx(t, ctx)
      const visible = new Set(idxs)
      const hl = new Set<string>()
      for (const f of direct) for (const c of f.cols) if (c.table === t.name) hl.add(c.column.toLowerCase())
      const cols = [...hl].map((h) => t.columns.find((c) => c.name.toLowerCase() === h)?.name ?? h)
      this.emit(ctx, {
        kind: 'apply-filters',
        detail: 'major',
        title: `Aplicar los filtros a ${t.name}`,
        explanation: `${t.name} es una tabla del modelo, así que solo se ven las filas que cumplen el contexto de filtro (columnas: ${cols.join(', ')}). Se ${idxs.length === 1 ? 'conserva' : 'conservan'} ${idxs.length} de ${pl(t.rows.length, 'fila', 'filas')}.`,
        span,
        tables: this.stage([
          snapshotTable(full, {
            role: 'source',
            highlight: hl,
            status: full.rows.map((_, i): RowStatus => (visible.has(i) ? 'kept' : 'removed')),
          }),
        ]),
      })
    }
  }

  /** Valores distintos de ciertas columnas de una tabla (conserva el linaje). */
  private distinctOf(src: TableValue, colIdx: number[], id: string, title: string): TableValue {
    const seen = new Set<string>()
    const rows = []
    for (const r of src.rows) {
      const cells = colIdx.map((i) => r.cells[i])
      const k = tupleKey(cells)
      if (seen.has(k)) continue
      seen.add(k)
      rows.push({ key: cells.map((c) => String(c)).join('|'), cells })
    }
    return { id, title, model: null, cols: colIdx.map((i) => ({ ...src.cols[i], isNew: undefined })), rows }
  }

  // ---------- valores escalares ----------

  private columnValue(n: ColRefNode, ctx: Ctx): Value {
    const name = n.column.toLowerCase()
    for (let i = ctx.rows.length - 1; i >= 0; i--) {
      const rc = ctx.rows[i]
      const idx = rc.table.cols.findIndex((c) =>
        n.table !== null
          ? c.lineage !== null && c.lineage.table.toLowerCase() === n.table.toLowerCase() && c.lineage.column.toLowerCase() === name
          : c.name.toLowerCase() === name,
      )
      if (idx >= 0) return rc.row.cells[idx]
    }
    const label = n.table !== null ? `${n.table}[${n.column}]` : `[${n.column}]`
    throw new EngineError(
      `No se puede determinar un único valor para ${label} porque no hay un contexto de fila. Una columna sola devuelve varios valores; usa una función de agregación como SUM(${label}) o un iterador como SUMX para recorrer las filas.`,
      n.span,
    )
  }

  evalScalar(n: Node, ctx: Ctx): Value {
    switch (n.type) {
      case 'num':
      case 'str':
      case 'bool':
        return n.value
      case 'blank':
        return null
      case 'tableRef':
        throw new EngineError(
          `'${n.name}' es una tabla y aquí se espera un único valor. Usa una función como COUNTROWS(${n.name}) o un iterador como SUMX para trabajar con sus filas.`,
          n.span,
        )
      case 'colRef':
        return this.columnValue(n, ctx)
      case 'unary': {
        const v = this.evalScalar(n.arg, ctx)
        return n.op === '-' ? -toNum(v, n.arg.span) : !toBool(v, n.arg.span)
      }
      case 'binary':
        return this.evalBinary(n.op, n.left, n.right, n.span, ctx)
      case 'in': {
        const v = this.evalScalar(n.left, ctx)
        let pool: Value[]
        if (n.list) pool = n.items.map((x) => this.evalScalar(x, ctx))
        else pool = this.evalTable(n.items[0], ctx).rows.map((r) => r.cells[0])
        return pool.some((x) => compareValues(v, x) === 0)
      }
      case 'call':
        return this.callScalar(n, ctx)
    }
  }

  private evalBinary(op: string, l: Node, r: Node, span: SourceSpan, ctx: Ctx): Value {
    if (hasNested(l) || hasNested(r)) {
      const nodes = [l, r]
      return this.combine(
        ctx,
        span,
        (vals) => (vals.length < 2 ? nodes[vals.length] : null),
        (vals) => this.applyBinary(op, vals[0], vals[1], l, r, span),
        (vals, res, from) => ({
          title: `Se combinan los resultados (${op})`,
          text: `Con los dos resultados ya calculados ${OP_WORDS[op] ?? 'se combinan'}: ${fmt(vals[0])} ${op} ${fmt(vals[1])} = ${fmt(res)}.${from}`,
        }),
      )
    }
    if (op === '&&') return toBool(this.evalScalar(l, ctx), l.span) && toBool(this.evalScalar(r, ctx), r.span)
    if (op === '||') return toBool(this.evalScalar(l, ctx), l.span) || toBool(this.evalScalar(r, ctx), r.span)
    return this.applyBinary(op, this.evalScalar(l, ctx), this.evalScalar(r, ctx), l, r, span)
  }

  private applyBinary(op: string, a: Value, b: Value, l: Node, r: Node, span: SourceSpan): Value {
    switch (op) {
      case '&&':
        return toBool(a, l.span) && toBool(b, r.span)
      case '||':
        return toBool(a, l.span) || toBool(b, r.span)
      case '+':
        return round(toNum(a, l.span) + toNum(b, r.span))
      case '-':
        return round(toNum(a, l.span) - toNum(b, r.span))
      case '*':
        return round(toNum(a, l.span) * toNum(b, r.span))
      case '/': {
        const d = toNum(b, r.span)
        if (d === 0) {
          throw new EngineError('No se puede dividir entre cero. Usa DIVIDE(a, b) para obtener BLANK en lugar de un error.', span)
        }
        return round(toNum(a, l.span) / d)
      }
      case '&':
        return toText(a) + toText(b)
      case '=':
      case '==':
        return compareValues(a, b) === 0
      case '<>':
        return compareValues(a, b) !== 0
      case '<':
        return compareValues(a, b) < 0
      case '<=':
        return compareValues(a, b) <= 0
      case '>':
        return compareValues(a, b) > 0
      default:
        return compareValues(a, b) >= 0
    }
  }

  /** Tablas del modelo que menciona una expresion. */
  private tablesOf(node: Node): Set<string> {
    const out = new Set<string>()
    walk(node, (x) => {
      try {
        if (x.type === 'tableRef') out.add(this.findTable(x.name, x.span).name)
        else if (x.type === 'colRef') out.add(this.modelColumn(x).table.name)
      } catch {
        // referencia a una columna calculada: no es del modelo
      }
    })
    return out
  }

  /** Tabla de la que lee el valor de un operando, si lee de una sola. */
  private sourceTableOf(node: Node): string | undefined {
    let n = node
    if (n.type === 'call' && (n.name === 'CALCULATE' || n.name === 'CALCULATETABLE') && n.args.length > 0) n = n.args[0]
    const t = this.tablesOf(n)
    return t.size === 1 ? [...t][0] : undefined
  }

  /**
   * Evalua operandos uno tras otro (el siguiente lo decide `next`), los deja a la vista como
   * resultados parciales y al final muestra el paso donde se combinan en un solo valor.
   */
  private combine(
    ctx: Ctx,
    span: SourceSpan,
    next: (vals: Value[]) => Node | null,
    compute: (vals: Value[]) => Value,
    explain: (vals: Value[], res: Value, from: string) => { title: string; text: string },
  ): Value {
    const base = this.partials.length
    const vals: Value[] = []
    const reads: ReadRec[][] = []
    try {
      for (;;) {
        const node = next(vals)
        if (!node) break
        this.focus.push(this.tablesOf(node))
        const r0 = this.readLog.length
        let v: Value
        try {
          v = this.evalScalar(node, ctx)
        } finally {
          this.focus.pop()
        }
        vals.push(v)
        reads.push(this.readLog.slice(r0))
        const p: PartialResult = { label: this.text(node.span, 40), value: v, span: node.span }
        const st = this.sourceTableOf(node)
        if (st) p.sourceTable = st
        this.partials.push(p)
      }
      const res = compute(vals)
      const mine = this.partials.slice(base)
      const snaps: TableSnapshot[] = []
      for (const rs of reads) {
        const last = new Map<string, ReadRec>()
        for (const rd of rs) last.set(rd.table, rd)
        for (const rd of last.values()) {
          const t = this.tableByName(rd.table)
          snaps.push(
            snapshotTable(this.modelTableValue(t, rd.idxs), {
              role: 'source',
              highlight: rd.col ? new Set([rd.col.toLowerCase()]) : undefined,
            }),
          )
        }
      }
      const names = new Set<string>([...snaps.map((x) => x.id), ...mine.flatMap((p) => (p.sourceTable ? [p.sourceTable] : []))])
      const from = mine
        .filter((p) => p.sourceTable)
        .map((p) => `${fmt(p.value)} sale de ${p.sourceTable}`)
        .join(' y ')
      const ex = explain(vals, res, from ? ` ${from}.` : '')
      if (names.size > 0) this.focus.push(names)
      try {
        this.emit(ctx, {
          kind: 'combine',
          detail: 'major',
          title: ex.title,
          explanation: ex.text,
          span,
          tables: this.stage(snaps),
          scalar: { label: this.text(span, 60), value: res },
        })
      } finally {
        if (names.size > 0) this.focus.pop()
      }
      return res
    } finally {
      this.partials.length = base
    }
  }

  private callScalar(n: CallNode, ctx: Ctx): Value {
    const name = n.name
    if (ITERATORS.has(name)) return this.evalIterator(n, ctx)
    if (AGG_COLUMN.has(name)) return this.aggColumn(n, ctx)
    switch (name) {
      case 'COUNTROWS':
        return this.countRows(n, ctx)
      case 'CALCULATE':
        return this.calculate(n, ctx, false) as Value
      case 'IF': {
        this.arity(n, 2, 3)
        if (n.args.some(hasNested)) {
          return this.combine(
            ctx,
            n.span,
            (vals) => {
              if (vals.length === 0) return n.args[0]
              if (vals.length === 1) return toBool(vals[0], n.args[0].span) ? n.args[1] : (n.args[2] ?? null)
              return null
            },
            (vals) => (toBool(vals[0], n.args[0].span) ? vals[1] : n.args.length === 3 ? vals[1] : null),
            (vals, res, from) => ({
              title: 'IF elige un resultado',
              text: `La condición dio ${fmt(vals[0])}, así que IF devuelve ${toBool(vals[0], n.args[0].span) ? 'el segundo argumento' : n.args.length === 3 ? 'el tercer argumento' : 'BLANK'}: ${fmt(res)}.${from}`,
            }),
          )
        }
        const c = toBool(this.evalScalar(n.args[0], ctx), n.args[0].span)
        if (c) return this.evalScalar(n.args[1], ctx)
        return n.args.length === 3 ? this.evalScalar(n.args[2], ctx) : null
      }
      case 'AND':
      case 'OR': {
        this.arity(n, 2, 2)
        if (n.args.some(hasNested)) {
          return this.combine(
            ctx,
            n.span,
            (vals) => (vals.length < 2 ? n.args[vals.length] : null),
            (vals) => this.applyBinary(name === 'AND' ? '&&' : '||', vals[0], vals[1], n.args[0], n.args[1], n.span),
            (vals, res, from) => ({
              title: `${name} combina las condiciones`,
              text: `${name}(${fmt(vals[0])}, ${fmt(vals[1])}) = ${fmt(res)}.${from}`,
            }),
          )
        }
        const a = toBool(this.evalScalar(n.args[0], ctx), n.args[0].span)
        const b = toBool(this.evalScalar(n.args[1], ctx), n.args[1].span)
        return name === 'AND' ? a && b : a || b
      }
      case 'NOT':
        this.arity(n, 1, 1)
        return !toBool(this.evalScalar(n.args[0], ctx), n.args[0].span)
      case 'ISBLANK':
        this.arity(n, 1, 1)
        return this.evalScalar(n.args[0], ctx) === null
      case 'DIVIDE': {
        this.arity(n, 2, 3)
        if (n.args.some(hasNested)) {
          return this.combine(
            ctx,
            n.span,
            (vals) => (vals.length < n.args.length ? n.args[vals.length] : null),
            (vals) => {
              const d0 = toNum(vals[1], n.args[1].span)
              return d0 === 0 ? (vals[2] ?? null) : round(toNum(vals[0], n.args[0].span) / d0)
            },
            (vals, res, from) => ({
              title: 'DIVIDE combina los resultados',
              text: `DIVIDE(${fmt(vals[0])}, ${fmt(vals[1])}) = ${fmt(res)}.${toNum(vals[1], null) === 0 ? ' Como el divisor es cero, DIVIDE devuelve el valor alternativo (o BLANK) en lugar de un error.' : ''}${from}`,
            }),
          )
        }
        const a = this.evalScalar(n.args[0], ctx)
        const b = this.evalScalar(n.args[1], ctx)
        const alt = n.args.length === 3 ? this.evalScalar(n.args[2], ctx) : null
        const d = toNum(b, n.args[1].span)
        return d === 0 ? alt : round(toNum(a, n.args[0].span) / d)
      }
      case 'TRUE':
        this.arity(n, 0, 0)
        return true
      case 'FALSE':
        this.arity(n, 0, 0)
        return false
      case 'BLANK':
        this.arity(n, 0, 0)
        return null
      case 'DATE': {
        this.arity(n, 3, 3)
        const [y, m, d] = n.args.map((a) => Math.trunc(toNum(this.evalScalar(a, ctx), a.span)))
        const last = m >= 1 && m <= 12 ? new Date(Date.UTC(2000, m, 0)).getUTCDate() - (m === 2 && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 1 : 0) : 0
        if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > last) {
          throw new EngineError('DATE espera un año, un mes y un día válidos, por ejemplo DATE(2026, 2, 1).', n.span)
        }
        const p = (x: number, w: number): string => String(x).padStart(w, '0')
        return `${p(y, 4)}-${p(m, 2)}-${p(d, 2)}`
      }
      case 'RELATED':
        return this.evalRelated(n, ctx)
      case 'USERELATIONSHIP':
        throw new EngineError('USERELATIONSHIP solo se puede usar como argumento de filtro de CALCULATE o CALCULATETABLE: activa la relación mientras se evalúa su expresión.', n.span)
      case 'REMOVEFILTERS':
      case 'KEEPFILTERS':
        throw new EngineError(`${name} solo se puede usar como argumento de filtro de CALCULATE o CALCULATETABLE.`, n.span)
      default:
        throw new EngineError(
          `${name} devuelve una tabla y aquí se espera un único valor. Envuélvela en una función como COUNTROWS o en un iterador.`,
          n.span,
        )
    }
  }

  // ---------- agregadores ----------

  private aggColumn(n: CallNode, ctx: Ctx): Value {
    this.arity(n, 1, 1)
    const arg = n.args[0]
    if (arg.type !== 'colRef') {
      throw new EngineError(
        `${n.name} espera una columna, por ejemplo ${n.name}(Ventas[Cantidad]). Para una expresión por fila usa la versión con X, como ${n.name}X.`,
        arg.span,
      )
    }
    const mc = this.modelColumn(arg)
    if (mc.table.columns[mc.ci].type === 'date' && (n.name === 'SUM' || n.name === 'AVERAGE')) {
      throw new EngineError(
        `${n.name} no se puede aplicar a una columna de fechas (${mc.table.name}[${mc.table.columns[mc.ci].name}]). Para fechas usa MIN, MAX, COUNT o DISTINCTCOUNT.`,
        arg.span,
      )
    }
    const vt = this.visibleTable(mc.table, ctx, n.span)
    this.readLog.push({ table: mc.table.name, idxs: vt.rows.map((r) => Number(r.key)), col: mc.table.columns[mc.ci].name })
    const vals = vt.rows.map((r) => r.cells[mc.ci])
    const value = aggregate(n.name, vals)
    const colName = qual({ table: mc.table.name, column: mc.table.columns[mc.ci].name })
    const detail =
      vals.length === 0
        ? 'No hay filas visibles, así que el resultado es BLANK.'
        : `${sumList(vals, n.name)}${fmt(value)}.`
    this.emit(ctx, {
      kind: 'aggregate',
      detail: 'major',
      title: `${n.name} de ${colName}`,
      explanation: `${n.name} ${verb[n.name]} ${colName} ${vt.rows.length === 1 ? 'en la única fila visible' : `en las ${vt.rows.length} filas visibles`}. ${detail}`,
      span: n.span,
      tables: this.stage([snapshotTable(vt, { role: 'source', highlight: new Set([mc.table.columns[mc.ci].name.toLowerCase()]) })]),
      scalar: { label: this.text(n.span, 60), value },
    })
    return value
  }

  private countRows(n: CallNode, ctx: Ctx): Value {
    this.arity(n, 1, 1)
    const arg = n.args[0]
    if (!this.isTableNode(arg)) {
      throw new EngineError('COUNTROWS espera una tabla, por ejemplo COUNTROWS(Ventas) o COUNTROWS(FILTER(...)).', arg.span)
    }
    const t = this.evalTable(arg, ctx)
    if (t.model !== null) this.readLog.push({ table: t.model, idxs: t.rows.map((r) => Number(r.key)), col: null })
    const value = t.rows.length === 0 ? null : t.rows.length
    this.emit(ctx, {
      kind: 'aggregate',
      detail: 'major',
      title: 'COUNTROWS cuenta las filas',
      explanation: value === null ? 'La tabla no tiene filas, así que COUNTROWS devuelve BLANK.' : `La tabla tiene ${pl(value, 'fila', 'filas')}, y ese es el resultado de COUNTROWS.`,
      span: n.span,
      tables: this.stage([snapshotTable(t, { role: this.roleOf(t) })]),
      scalar: { label: this.text(n.span, 60), value },
    })
    return value
  }

  // ---------- iteracion fila a fila ----------

  /** Texto de una expresion con las columnas sustituidas por sus valores en la fila actual. */
  private render(node: Node, rctx: Ctx): string {
    const items: { span: SourceSpan; get: () => Value }[] = []
    const collect = (x: Node): void => {
      if (x.type === 'colRef') items.push({ span: x.span, get: () => this.columnValue(x, rctx) })
      else if (x.type === 'call' && (x.name === 'RELATED' || x.name === 'DATE')) items.push({ span: x.span, get: () => this.evalScalar(x, rctx) })
      else if (x.type === 'call' && !ROW_LEVEL.has(x.name)) return
      else if (x.type === 'unary') collect(x.arg)
      else if (x.type === 'binary') {
        collect(x.left)
        collect(x.right)
      } else if (x.type === 'in') {
        collect(x.left)
        x.items.forEach(collect)
      } else if (x.type === 'call') x.args.forEach(collect)
    }
    collect(node)
    items.sort((a, b) => a.span.start - b.span.start)
    let out = ''
    let pos = node.span.start
    try {
      for (const r of items) {
        out += this.src.slice(pos, r.span.start) + fmt(r.get())
        pos = r.span.end
      }
    } catch {
      return this.text(node.span)
    }
    out += this.src.slice(pos, node.span.end)
    return out.replace(/\s+/g, ' ').trim()
  }

  private loop(T: TableValue, ctx: Ctx, spec: LoopSpec): { vals: Value[][]; decisions: Decision[] } {
    const n = T.rows.length
    const hl = this.refNames(spec.exprs)
    const span = { start: spec.exprs[0].span.start, end: spec.exprs[spec.exprs.length - 1].span.end }
    const nested = spec.exprs.some(hasNested)
    const extra = spec.newCols ?? []
    const vals: Value[][] = []
    const decisions: Decision[] = []
    let cur = -1
    let curCtx: Ctx = ctx

    const curVals: (Value | undefined)[] = []
    const snap = (): TableSnapshot => {
      // valor que acaba de calcular una subexpresion de la fila actual (aun sin decidir)
      const k = this.landing && cur >= 0 && !decisions[cur] ? spec.exprs.indexOf(this.landing.node) : -1
      const landed = k >= 0 && this.landing ? this.landing.value : null
      const known = (q: number): boolean => q === k || curVals[q] !== undefined
      const valueAt = (q: number): Value => (q === k ? landed : (curVals[q] ?? null))
      const t2: TableValue =
        extra.length === 0
          ? T
          : {
              ...T,
              cols: [...T.cols, ...extra.map((name, q) => ({ name, lineage: null, isNew: true, type: inferType(vals.map((v) => v[q])) }))],
              rows: T.rows.map((r, j) => {
                const cells: Value[] = vals[j] ? [...vals[j]] : extra.map(() => null)
                if (j === cur && !vals[j]) extra.forEach((_, q) => (cells[q] = known(q) ? valueAt(q) : null))
                return { key: r.key, cells: [...r.cells, ...cells] }
              }),
            }
      const notes = T.rows.map((_, j) => (j <= cur ? decisions[j]?.note : undefined))
      if (cur >= 0 && !decisions[cur]) {
        if (extra.length > 0) {
          const parts = extra.flatMap((nm, q) => (known(q) ? [`${nm} = ${fmt(valueAt(q))}`] : []))
          if (parts.length > 0) notes[cur] = parts.join(', ')
        } else if (k >= 0) {
          notes[cur] = `${this.render(spec.exprs[k], curCtx)} = ${fmt(landed)}`
        }
      }
      return snapshotTable(t2, {
        role: spec.role,
        highlight: hl,
        status: T.rows.map((_, j): RowStatus => (j === cur ? 'active' : j < cur ? decisions[j].status : 'normal')),
        notes,
      })
    }

    this.pins.push({ snap })
    try {
      for (let i = 0; i < n; i++) {
        cur = i
        const rctx: Ctx = { filters: ctx.filters, rows: [...ctx.rows, { table: T, row: T.rows[i] }], active: ctx.active }
        curCtx = rctx
        curVals.length = 0
        if (nested) {
          this.emit(rctx, {
            kind: 'iterate-row',
            detail: 'minor',
            title: `Fila ${i + 1} de ${n}`,
            explanation: spec.intro(i, n),
            span,
            tables: this.stage([]),
          })
        }
        const v = spec.exprs.map((e, q) => {
          const x = this.evalScalar(e, rctx)
          curVals[q] = x
          return x
        })
        vals.push(v)
        const d = spec.decide(v, i, rctx)
        decisions.push(d)
        this.emit(rctx, {
          kind: 'iterate-row',
          detail: 'minor',
          title: `Fila ${i + 1} de ${n}`,
          explanation: d.explanation,
          span,
          tables: this.stage([]),
        })
      }
    } finally {
      this.pins.pop()
    }
    return { vals, decisions }
  }

  private filterRows(
    T: TableValue,
    cond: Node,
    ctx: Ctx,
    o: { role: TableRole; span: SourceSpan; title: string; rowsWord: [string, string] },
  ): TableValue {
    const { decisions } = this.loop(T, ctx, {
      exprs: [cond],
      role: o.role,
      intro: (i, n) => `Fila ${i + 1} de ${n}: se evalúa la condición para esta fila, con las columnas tomando los valores de la fila actual.`,
      decide: (vals, i, rctx) => {
        const b = toBool(vals[0], cond.span)
        const word = b ? 'VERDADERO' : 'FALSO'
        return {
          note: `${this.render(cond, rctx)} -> ${word}`,
          status: b ? 'kept' : 'removed',
          explanation: `Fila ${i + 1}: la condición da ${word}, así que la fila se ${b ? 'conserva' : 'descarta'}.`,
        }
      },
    })
    const kept: TableValue = {
      ...T,
      title: o.title,
      rows: T.rows.filter((_, i) => decisions[i].status === 'kept'),
    }
    this.emit(ctx, {
      kind: 'table-result',
      detail: 'major',
      title: `${kept.rows.length === 1 ? 'Queda' : 'Quedan'} ${kept.rows.length} de ${pl(T.rows.length, o.rowsWord[0], o.rowsWord[1])}`,
      explanation: `Las filas descartadas desaparecen y solo quedan las que cumplen la condición: ${kept.rows.length} de ${T.rows.length}.`,
      span: o.span,
      tables: this.stage([snapshotTable(kept, { role: o.role })]),
    })
    return kept
  }

  private evalIterator(n: CallNode, ctx: Ctx): Value {
    this.arity(n, 2, 2)
    const [tArg, eArg] = n.args
    if (!this.isTableNode(tArg)) {
      throw new EngineError(`El primer argumento de ${n.name} debe ser una tabla, por ejemplo ${n.name}(Ventas, ...).`, tArg.span)
    }
    const base = n.name.slice(0, -1)
    this.emit(ctx, {
      kind: 'enter',
      detail: 'major',
      title: `Entra ${n.name}`,
      explanation: `${n.name} recorre cada fila de \`${this.text(tArg.span, 50)}\`, calcula \`${this.text(eArg.span, 50)}\` con esa fila como contexto de fila y al final ${verb[base]} los resultados.`,
      span: n.span,
      tables: this.stage([]),
    })
    const T = this.evalTable(tArg, ctx)
    const { vals } = this.loop(T, ctx, {
      exprs: [eArg],
      role: this.roleOf(T),
      intro: (i, nn) => `Fila ${i + 1} de ${nn}: se calcula la expresión para esta fila.`,
      decide: (v, i, rctx) => {
        const note = `${this.render(eArg, rctx)} = ${fmt(v[0])}`
        return { note, status: 'kept', explanation: `Fila ${i + 1}: ${note}.` }
      },
    })
    const results = vals.map((v) => v[0])
    const value = aggregate(n.name, results)
    this.emit(ctx, {
      kind: 'aggregate',
      detail: 'major',
      title: `${n.name} reúne los resultados`,
      explanation:
        T.rows.length === 0
          ? 'No hay filas que recorrer, así que el resultado es BLANK.'
          : `${n.name} ${verb[base]} ${results.length === 1 ? 'el único valor calculado' : `los ${results.length} valores calculados`}: ${sumList(results, n.name)}${fmt(value)}.`,
      span: n.span,
      tables: this.stage([snapshotTable(T, { role: this.roleOf(T) })]),
      scalar: { label: this.text(n.span, 60), value },
    })
    return value
  }

  // ---------- funciones de tabla ----------

  evalTable(n: Node, ctx: Ctx): TableValue {
    if (n.type === 'tableRef') return this.visibleTable(this.findTable(n.name, n.span), ctx, n.span)
    if (n.type === 'call') {
      switch (n.name) {
        case 'FILTER':
          return this.evalFilter(n, ctx)
        case 'ALL':
          return this.evalAll(n, ctx)
        case 'VALUES':
        case 'DISTINCT':
          return this.evalValues(n, ctx)
        case 'CALCULATETABLE':
          return this.calculate(n, ctx, true) as TableValue
        case 'RELATEDTABLE':
          return this.evalRelatedTable(n, ctx)
        case 'UNION':
          return this.evalUnion(n, ctx)
        case 'INTERSECT':
          return this.evalSetFilter(n, ctx, true)
        case 'EXCEPT':
          return this.evalSetFilter(n, ctx, false)
        case 'CROSSJOIN':
          return this.evalCrossJoin(n, ctx)
        case 'TREATAS':
          return this.evalTreatAs(n, ctx)
        case 'ADDCOLUMNS':
        case 'SELECTCOLUMNS':
          return this.evalColumns(n, ctx)
      }
    }
    throw new EngineError('Aquí se esperaba una tabla (por ejemplo Ventas, FILTER(...) o VALUES(...)).', n.span)
  }

  private evalFilter(n: CallNode, ctx: Ctx): TableValue {
    this.arity(n, 2, 2)
    const [tArg, cond] = n.args
    if (!this.isTableNode(tArg)) {
      throw new EngineError('El primer argumento de FILTER debe ser una tabla, por ejemplo FILTER(Ventas, ...).', tArg.span)
    }
    this.emit(ctx, {
      kind: 'enter',
      detail: 'major',
      title: 'Entra FILTER',
      explanation: `FILTER primero obtiene la tabla \`${this.text(tArg.span, 50)}\` y luego recorre sus filas una por una, evaluando \`${this.text(cond.span, 60)}\` en cada una. Conserva las filas donde da VERDADERO.`,
      span: n.span,
      tables: this.stage([]),
    })
    const T = this.evalTable(tArg, ctx)
    return this.filterRows(T, cond, ctx, { role: this.roleOf(T), span: n.span, title: this.text(n.span, 50), rowsWord: ['fila', 'filas'] })
  }

  private evalAll(n: CallNode, ctx: Ctx): TableValue {
    this.arity(n, 1, Infinity)
    const id = `ALL@${n.span.start}-${n.span.end}`
    const title = this.text(n.span, 50)
    let out: TableValue
    let what: string
    if (n.args.length === 1 && n.args[0].type === 'tableRef') {
      const t = this.findTable(n.args[0].name, n.args[0].span)
      const full = this.modelTableValue(t, this.allIdx(t))
      out = { ...full, id, title, model: null }
      what = `${t.rows.length === 1 ? 'la única fila' : `todas las ${t.rows.length} filas`} de ${t.name}`
    } else {
      const cols = n.args.map((a) => {
        if (a.type !== 'colRef') {
          throw new EngineError('ALL espera una tabla o una o más columnas de la misma tabla, por ejemplo ALL(Ventas[Producto]).', a.span)
        }
        return { node: a, mc: this.modelColumn(a) }
      })
      const t0 = cols[0].mc.table
      for (const c of cols) {
        if (c.mc.table !== t0) throw new EngineError('Las columnas de ALL deben ser de la misma tabla.', c.node.span)
      }
      const full = this.modelTableValue(t0, this.allIdx(t0))
      out = this.distinctOf(full, cols.map((c) => c.mc.ci), id, title)
      what = `${pl(out.rows.length, 'combinación distinta', 'combinaciones distintas')} de ${cols.map((c) => qual({ table: t0.name, column: t0.columns[c.mc.ci].name })).join(', ')}`
    }
    this.emit(ctx, {
      kind: 'enter',
      detail: 'major',
      title: 'Entra ALL',
      explanation: `ALL ignora los filtros del contexto actual (${ctx.filters.length === 0 ? 'ahora no hay ninguno' : 'ahora hay ' + ctx.filters.length}) y devuelve ${what}.`,
      span: n.span,
      tables: this.stage([]),
    })
    this.emit(ctx, {
      kind: 'table-result',
      detail: 'major',
      title: 'ALL devuelve la tabla completa',
      explanation: `El resultado de ALL tiene ${pl(out.rows.length, 'fila', 'filas')}, sin importar los filtros.`,
      span: n.span,
      tables: this.stage([snapshotTable(out, { role: 'working' })]),
    })
    return out
  }

  private evalValues(n: CallNode, ctx: Ctx): TableValue {
    this.arity(n, 1, 1)
    const arg = n.args[0]
    const id = `${n.name}@${n.span.start}-${n.span.end}`
    const title = this.text(n.span, 50)
    this.emit(ctx, {
      kind: 'enter',
      detail: 'major',
      title: `Entra ${n.name}`,
      explanation:
        n.name === 'VALUES'
          ? `VALUES devuelve los valores distintos de \`${this.text(arg.span, 50)}\` que son visibles en el contexto de filtro actual.`
          : `DISTINCT devuelve los valores o filas distintos de \`${this.text(arg.span, 50)}\` visibles en el contexto de filtro actual.`,
      span: n.span,
      tables: this.stage([]),
    })
    let out: TableValue
    if (arg.type === 'colRef') {
      const mc = this.modelColumn(arg)
      const vt = this.visibleTable(mc.table, ctx, arg.span)
      out = this.distinctOf(vt, [mc.ci], id, title)
    } else {
      if (n.name === 'VALUES' && arg.type !== 'tableRef') {
        throw new EngineError('VALUES espera una columna o una tabla del modelo, por ejemplo VALUES(Ventas[Producto]).', arg.span)
      }
      if (!this.isTableNode(arg)) {
        throw new EngineError(`${n.name} espera una columna o una tabla.`, arg.span)
      }
      const base = this.evalTable(arg, ctx)
      out = this.distinctOf(base, base.cols.map((_, i) => i), id, title)
    }
    this.emit(ctx, {
      kind: 'table-result',
      detail: 'major',
      title: `${n.name} devuelve ${pl(out.rows.length, 'valor', 'valores')}`,
      explanation: `${out.rows.length === 1 ? 'Queda' : 'Quedan'} los valores distintos, sin repetir: ${pl(out.rows.length, 'fila', 'filas')}.`,
      span: n.span,
      tables: this.stage([snapshotTable(out, { role: 'working' })]),
    })
    return out
  }

  private evalColumns(n: CallNode, ctx: Ctx): TableValue {
    const isAdd = n.name === 'ADDCOLUMNS'
    this.arity(n, 3, Infinity)
    if (n.args.length % 2 === 0) {
      throw new EngineError(`${n.name} espera pares de nombre y expresión: ${n.name}(tabla, "Nombre", expresión, ...).`, n.span)
    }
    const tArg = n.args[0]
    if (!this.isTableNode(tArg)) {
      throw new EngineError(`El primer argumento de ${n.name} debe ser una tabla.`, tArg.span)
    }
    const names: string[] = []
    const exprs: Node[] = []
    for (let i = 1; i < n.args.length; i += 2) {
      const nm = n.args[i]
      if (nm.type !== 'str') throw new EngineError('El nombre de la columna nueva debe ser un texto entre comillas, por ejemplo "Total".', nm.span)
      names.push(nm.value)
      exprs.push(n.args[i + 1])
    }
    this.emit(ctx, {
      kind: 'enter',
      detail: 'major',
      title: `Entra ${n.name}`,
      explanation: isAdd
        ? `ADDCOLUMNS toma la tabla \`${this.text(tArg.span, 50)}\` y, para cada fila, calcula ${names.length === 1 ? 'la columna' : 'las columnas'} ${names.map((x) => `"${x}"`).join(', ')} con esa fila como contexto de fila.`
        : `SELECTCOLUMNS recorre la tabla \`${this.text(tArg.span, 50)}\` y construye una tabla nueva solo con las columnas ${names.map((x) => `"${x}"`).join(', ')}, calculadas fila por fila.`,
      span: n.span,
      tables: this.stage([]),
    })
    const T = this.evalTable(tArg, ctx)
    const { vals } = this.loop(T, ctx, {
      exprs,
      role: this.roleOf(T),
      newCols: names,
      intro: (i, nn) => `Fila ${i + 1} de ${nn}: se calculan las columnas nuevas para esta fila.`,
      decide: (v, i) => {
        const note = names
          .map((nm, k) => {
            const e = exprs[k]
            return e.type === 'call' && e.name === 'RELATED' ? `${this.text(e.span)} = ${fmt(v[k])}` : `${nm} = ${fmt(v[k])}`
          })
          .join(', ')
        return { note, status: 'kept', explanation: `Fila ${i + 1}: ${note}.` }
      },
    })
    const newCols = names.map((name, k) => {
      const e = exprs[k]
      let lineage: TableValue['cols'][number]['lineage'] = null
      if (!isAdd && e.type === 'colRef') {
        const m = T.cols.find((c) =>
          e.table !== null
            ? c.lineage !== null && c.lineage.table.toLowerCase() === e.table.toLowerCase() && c.lineage.column.toLowerCase() === e.column.toLowerCase()
            : c.name.toLowerCase() === e.column.toLowerCase(),
        )
        lineage = m?.lineage ?? null
      }
      const type: ColumnType | undefined = lineage
        ? T.cols.find((c) => c.lineage === lineage)?.type
        : inferType(vals.map((v) => v[k]))
      return { name, lineage, isNew: true, type }
    })
    const out: TableValue = isAdd
      ? {
          ...T,
          title: this.text(n.span, 50),
          cols: [...T.cols, ...newCols],
          rows: T.rows.map((r, i) => ({ key: r.key, cells: [...r.cells, ...vals[i]] })),
        }
      : {
          id: `SELECTCOLUMNS@${n.span.start}-${n.span.end}`,
          title: this.text(n.span, 50),
          model: null,
          cols: newCols,
          rows: T.rows.map((r, i) => ({ key: r.key, cells: [...vals[i]] })),
        }
    this.emit(ctx, {
      kind: 'table-result',
      detail: 'major',
      title: isAdd ? 'Tabla con las columnas nuevas' : 'Tabla con las columnas elegidas',
      explanation: isAdd
        ? `Cada fila conserva sus columnas originales y suma ${names.length === 1 ? 'la nueva' : 'las nuevas'}: ${names.join(', ')}.`
        : `El resultado solo contiene las columnas calculadas: ${names.join(', ')}.`,
      span: n.span,
      tables: this.stage([snapshotTable(out, { role: 'working' })]),
    })
    return out
  }

  // ---------- CALCULATE / CALCULATETABLE ----------

  private classify(arg: Node): FSpec {
    let keep = false
    let node = arg
    while (node.type === 'call' && node.name === 'KEEPFILTERS') {
      if (node.args.length !== 1) throw new EngineError('KEEPFILTERS espera exactamente 1 argumento.', node.span)
      keep = true
      node = node.args[0]
    }
    if (node.type === 'call' && node.name === 'USERELATIONSHIP') {
      if (keep) throw new EngineError('KEEPFILTERS no se puede combinar con USERELATIONSHIP.', arg.span)
      return { kind: 'userel', node, keep }
    }
    if (node.type === 'call' && (node.name === 'ALL' || node.name === 'REMOVEFILTERS')) {
      if (keep) throw new EngineError('KEEPFILTERS no se puede combinar con ALL ni REMOVEFILTERS.', arg.span)
      return { kind: 'modifier', node, keep }
    }
    if (this.isTableNode(node)) return { kind: 'table', node, keep }
    return { kind: 'predicate', node, keep }
  }

  private modSpec(call: CallNode): ModSpec {
    if (call.args.length === 0) {
      return { call, drop: () => true, what: 'todas las tablas' }
    }
    if (call.args.every((a) => a.type === 'tableRef')) {
      const tables = call.args.map((a) => this.findTable((a as { name: string }).name, a.span).name)
      return { call, drop: (c) => tables.includes(c.table), what: tables.join(', ') }
    }
    if (call.args.every((a) => a.type === 'colRef')) {
      const cols = call.args.map((a) => {
        const mc = this.modelColumn(a as ColRefNode)
        return { table: mc.table.name, column: mc.table.columns[mc.ci].name }
      })
      return {
        call,
        drop: (c) => cols.some((x) => qual(x) === qual(c)),
        what: cols.map(qual).join(', '),
      }
    }
    throw new EngineError(`${call.name} espera una tabla o solo columnas, no una mezcla.`, call.span)
  }

  /** Reescribe un filtro booleano como FILTER(ALL(columnas), predicado) y devuelve el filtro resultante. */
  private predicateFilter(node: Node, ctx: Ctx): Filter {
    walk(node, (x) => {
      if (x.type === 'call' && !ROW_LEVEL.has(x.name)) {
        throw new EngineError(
          `Un filtro booleano no puede contener ${x.name}: solo admite comparaciones de columnas con valores. Si necesitas una agregación, usa FILTER(...) como argumento de filtro.`,
          x.span,
        )
      }
      if (x.type === 'call' && x.name === 'RELATED') {
        throw new EngineError('RELATED no se puede usar en un filtro booleano de CALCULATE: ahí no hay contexto de fila. Escribe la condición directamente sobre la columna de la otra tabla, por ejemplo Productos[Marca] = "Limpio".', x.span)
      }
      if (x.type === 'tableRef') {
        throw new EngineError('Un filtro booleano no puede usar una tabla completa, solo columnas.', x.span)
      }
    })
    const refs: ColRefNode[] = []
    walk(node, (x) => {
      if (x.type === 'colRef') refs.push(x)
    })
    if (refs.length === 0) {
      throw new EngineError(
        'Un filtro booleano debe referirse al menos a una columna, por ejemplo Ventas[Cantidad] = 5. Sin columnas no hay nada que filtrar.',
        node.span,
      )
    }
    const resolved = refs.map((r) => this.modelColumn(r))
    const tbl = resolved[0].table
    const other = resolved.findIndex((r) => r.table !== tbl)
    if (other >= 0) {
      throw new EngineError('Un filtro booleano solo puede usar columnas de una misma tabla.', refs[other].span)
    }
    const colIdx: number[] = []
    for (const r of resolved) if (!colIdx.includes(r.ci)) colIdx.push(r.ci)
    const fcols: FCol[] = colIdx.map((i) => ({ table: tbl.name, column: tbl.columns[i].name }))
    const full = this.modelTableValue(tbl, this.allIdx(tbl))
    const id = `ALL@${node.span.start}-${node.span.end}`
    const colsText = fcols.map(qual).join(', ')
    const combos = this.distinctOf(full, colIdx, id, `ALL(${colsText})`)
    const pred = this.text(node.span)
    this.emit(ctx, {
      kind: 'rewrite',
      detail: 'major',
      title: 'El filtro booleano se reescribe',
      explanation: `\`${pred}\` es un atajo: DAX lo trata como \`FILTER(ALL(${colsText}), ${pred})\`. ALL arma ${pl(combos.rows.length, 'combinación distinta', 'combinaciones distintas')} de esas columnas, ignorando los filtros actuales, y FILTER se queda con las que cumplen la condición.`,
      span: node.span,
      tables: this.stage([snapshotTable(combos, { role: 'filter', highlight: new Set(fcols.map((c) => c.column.toLowerCase())) })]),
    })
    const kept = this.filterRows(combos, node, ctx, { role: 'filter', span: node.span, title: this.text(node.span, 50), rowsWord: ['combinación', 'combinaciones'] })
    return { id: this.newId('F'), cols: fcols, rows: kept.rows.map((r) => r.cells) }
  }

  private tableFilter(node: Node, ctx: Ctx): Filter {
    const T = this.evalTable(node, ctx)
    const idx = T.cols.map((c, i) => (c.lineage ? i : -1)).filter((i) => i >= 0)
    if (idx.length === 0) {
      throw new EngineError('Esta tabla no tiene columnas que provengan del modelo, así que no se puede usar como filtro.', node.span)
    }
    const seen = new Set<string>()
    const rows: Value[][] = []
    for (const r of T.rows) {
      const cells = idx.map((i) => r.cells[i])
      const k = tupleKey(cells)
      if (!seen.has(k)) {
        seen.add(k)
        rows.push(cells)
      }
    }
    return {
      id: this.newId('F'),
      cols: idx.map((i) => {
        const l = T.cols[i].lineage as { table: string; column: string }
        return { table: l.table, column: l.column }
      }),
      rows,
    }
  }

  // ---------- funciones que combinan tablas ----------

  private tableArgs(n: CallNode, from = 0, to = n.args.length): void {
    for (let i = from; i < to; i++) {
      if (!this.isTableNode(n.args[i])) {
        throw new EngineError(`Los argumentos de ${n.name} deben ser tablas, por ejemplo ${n.name}(VALUES(Ventas[Producto]), VALUES(Devoluciones[Producto])).`, n.args[i].span)
      }
    }
  }

  private plainCols(t: TableValue): TableValue['cols'] {
    return t.cols.map((c) => ({ name: c.name, lineage: c.lineage, type: c.type }))
  }

  private evalUnion(n: CallNode, ctx: Ctx): TableValue {
    this.arity(n, 2, Infinity)
    this.tableArgs(n)
    this.emit(ctx, {
      kind: 'enter',
      detail: 'major',
      title: 'Entra UNION',
      explanation: 'UNION pega las tablas una debajo de otra: todas deben tener el mismo número de columnas, las filas se agregan en orden y los duplicados se conservan. Los nombres de columna salen de la primera tabla.',
      span: n.span,
      tables: this.stage([]),
    })
    const ts = n.args.map((a) => this.evalTable(a, ctx))
    ts.forEach((t, i) => {
      if (t.cols.length !== ts[0].cols.length) {
        throw new EngineError(
          `UNION necesita tablas con el mismo número de columnas: la primera tiene ${pl(ts[0].cols.length, 'columna', 'columnas')} y la ${i + 1 === 2 ? 'segunda' : 'número ' + (i + 1)} tiene ${t.cols.length}.`,
          n.args[i].span,
        )
      }
    })
    const inputs = ts.slice(0, 3).map((t) => snapshotTable(t, { role: 'working' }))
    this.emit(ctx, {
      kind: 'combine',
      detail: 'major',
      title: 'Las tablas de entrada',
      explanation: `UNION recibe ${ts.length} tablas con ${ts.map((t) => pl(t.rows.length, 'fila', 'filas')).join(' y ')}.`,
      span: n.span,
      tables: this.stageOnly(inputs),
    })
    const out: TableValue = {
      id: `UNION@${n.span.start}-${n.span.end}`,
      title: this.text(n.span, 50),
      model: null,
      cols: this.plainCols(ts[0]),
      rows: ts.flatMap((t, i) => t.rows.map((r) => ({ key: `${i + 1}:${r.key}`, cells: r.cells }))),
    }
    const notes = ts.flatMap((_, i) => ts[i].rows.map(() => `Tabla ${i + 1}: ${this.text(n.args[i].span, 30)}`))
    this.emit(ctx, {
      kind: 'table-result',
      detail: 'major',
      title: `UNION devuelve ${pl(out.rows.length, 'fila', 'filas')}`,
      explanation: `Se agregaron las filas de cada tabla (${ts.map((t) => t.rows.length).join(' + ')} = ${out.rows.length}) sin quitar duplicados. La nota de cada fila dice de qué tabla viene.`,
      span: n.span,
      tables: this.stageOnly([
        ...(ts.length <= 2 ? inputs : []),
        snapshotTable(out, { role: 'working', notes, status: out.rows.map((): RowStatus => 'added') }),
      ]),
    })
    return out
  }

  private evalSetFilter(n: CallNode, ctx: Ctx, keepIfFound: boolean): TableValue {
    this.arity(n, 2, 2)
    this.tableArgs(n)
    this.emit(ctx, {
      kind: 'enter',
      detail: 'major',
      title: `Entra ${n.name}`,
      explanation: keepIfFound
        ? 'INTERSECT devuelve las filas de la primera tabla que también aparecen en la segunda. Las filas se comparan por posición de columna, y los duplicados de la primera tabla se conservan.'
        : 'EXCEPT devuelve las filas de la primera tabla que no aparecen en la segunda. Las filas se comparan por posición de columna, y los duplicados de la primera tabla se conservan.',
      span: n.span,
      tables: this.stage([]),
    })
    const t1 = this.evalTable(n.args[0], ctx)
    const t2raw = this.evalTable(n.args[1], ctx)
    if (t1.cols.length !== t2raw.cols.length) {
      throw new EngineError(
        `${n.name} necesita tablas con el mismo número de columnas: la primera tiene ${pl(t1.cols.length, 'columna', 'columnas')} y la segunda tiene ${t2raw.cols.length}.`,
        n.args[1].span,
      )
    }
    const t2: TableValue = t2raw.id === t1.id ? { ...t2raw, id: t2raw.id + '#2' } : t2raw
    const first = new Map<string, number>()
    t2.rows.forEach((r, j) => {
      const k = tupleKey(r.cells)
      if (!first.has(k)) first.set(k, j)
    })
    const n1 = t1.rows.length
    const statuses: RowStatus[] = []
    const notes: string[] = []
    const label = (cells: Value[]): string => (cells.length === 1 ? fmt(cells[0]) : '(' + cells.map(fmt).join(', ') + ')')
    for (let i = 0; i < n1; i++) {
      const cells = t1.rows[i].cells
      const j = first.get(tupleKey(cells))
      const found = j !== undefined
      const keep = keepIfFound ? found : !found
      const note = `${label(cells)} ${found ? 'está' : 'no está'} en la segunda tabla -> ${keep ? 'se conserva' : 'se descarta'}`
      statuses.push(keep ? 'kept' : 'removed')
      notes.push(note)
      this.emit(ctx, {
        kind: 'iterate-row',
        detail: 'minor',
        title: `Fila ${i + 1} de ${n1}`,
        explanation: `Fila ${i + 1}: ${note}.`,
        span: n.span,
        tables: this.stageOnly([
          snapshotTable(t1, {
            role: 'working',
            status: t1.rows.map((_, q): RowStatus => (q === i ? 'active' : q < i ? statuses[q] : 'normal')),
            notes: t1.rows.map((_, q) => (q <= i ? notes[q] : undefined)),
          }),
          snapshotTable(t2, { role: 'working', status: t2.rows.map((_, q): RowStatus => (q === j ? 'active' : 'normal')) }),
        ]),
      })
    }
    const kept: TableValue = { ...t1, title: this.text(n.span, 50), rows: t1.rows.filter((_, i) => statuses[i] === 'kept') }
    this.emit(ctx, {
      kind: 'table-result',
      detail: 'major',
      title: `${kept.rows.length === 1 ? 'Queda' : 'Quedan'} ${kept.rows.length} de ${pl(n1, 'fila', 'filas')}`,
      explanation: `${n.name} se queda con ${pl(kept.rows.length, 'fila', 'filas')} de la primera tabla.`,
      span: n.span,
      tables: this.stageOnly([snapshotTable(kept, { role: 'working' })]),
    })
    return kept
  }

  private evalCrossJoin(n: CallNode, ctx: Ctx): TableValue {
    this.arity(n, 2, Infinity)
    this.tableArgs(n)
    this.emit(ctx, {
      kind: 'enter',
      detail: 'major',
      title: 'Entra CROSSJOIN',
      explanation: 'CROSSJOIN combina cada fila de la primera tabla con cada fila de las demás: el resultado tiene todas las combinaciones posibles. Los nombres de columna no pueden repetirse.',
      span: n.span,
      tables: this.stage([]),
    })
    const ts = n.args.map((a) => this.evalTable(a, ctx))
    const seen = new Set<string>()
    ts.forEach((t, i) => {
      for (const c of t.cols) {
        const k = c.name.toLowerCase()
        if (seen.has(k)) {
          throw new EngineError(`CROSSJOIN no admite columnas con el mismo nombre, y '${c.name}' aparece en más de una tabla.`, n.args[i].span)
        }
        seen.add(k)
      }
    })
    const total = ts.reduce((acc, t) => acc * t.rows.length, 1)
    if (total > 5000) {
      throw new EngineError(`CROSSJOIN generaría ${total} filas, demasiadas para mostrarlas. Prueba con tablas más pequeñas.`, n.span)
    }
    const inputs = ts.slice(0, 3).map((t) => snapshotTable(t, { role: 'working' }))
    this.emit(ctx, {
      kind: 'combine',
      detail: 'major',
      title: 'Las tablas de entrada',
      explanation: `CROSSJOIN recibe ${ts.length} tablas con ${ts.map((t) => pl(t.rows.length, 'fila', 'filas')).join(' y ')}.`,
      span: n.span,
      tables: this.stageOnly(inputs),
    })
    let rows: { key: string; cells: Value[] }[] = [{ key: '', cells: [] }]
    for (const t of ts) {
      const nextRows: { key: string; cells: Value[] }[] = []
      for (const a of rows) for (const b of t.rows) nextRows.push({ key: a.key === '' ? b.key : `${a.key}x${b.key}`, cells: [...a.cells, ...b.cells] })
      rows = nextRows
    }
    const out: TableValue = {
      id: `CROSSJOIN@${n.span.start}-${n.span.end}`,
      title: this.text(n.span, 50),
      model: null,
      cols: ts.flatMap((t) => this.plainCols(t)),
      rows,
    }
    this.emit(ctx, {
      kind: 'table-result',
      detail: 'major',
      title: `CROSSJOIN devuelve ${pl(total, 'fila', 'filas')}`,
      explanation: `Cada fila de una tabla se combina con cada fila de la otra: ${ts.map((t) => t.rows.length).join(' x ')} = ${pl(total, 'fila', 'filas')}.`,
      span: n.span,
      tables: this.stageOnly([...(ts.length <= 2 ? inputs : []), snapshotTable(out, { role: 'working', status: out.rows.map((): RowStatus => 'added') })]),
    })
    return out
  }

  private evalTreatAs(n: CallNode, ctx: Ctx): TableValue {
    this.arity(n, 2, Infinity)
    this.tableArgs(n, 0, 1)
    const targets = n.args.slice(1).map((a) => {
      if (a.type !== 'colRef') {
        throw new EngineError('TREATAS espera columnas del modelo después de la tabla, por ejemplo TREATAS(VALUES(Ventas[Producto]), Devoluciones[Producto]).', a.span)
      }
      const mc = this.modelColumn(a)
      return { table: mc.table.name, column: mc.table.columns[mc.ci].name, type: mc.table.columns[mc.ci].type }
    })
    const T = this.evalTable(n.args[0], ctx)
    if (T.cols.length !== targets.length) {
      throw new EngineError(
        `TREATAS necesita tantas columnas como tiene la tabla: la tabla tiene ${pl(T.cols.length, 'columna', 'columnas')} y se indicaron ${targets.length}.`,
        n.span,
      )
    }
    const out: TableValue = {
      id: `TREATAS@${n.span.start}-${n.span.end}`,
      title: this.text(n.span, 50),
      model: null,
      cols: targets.map((t) => ({ name: t.column, lineage: { table: t.table, column: t.column }, type: t.type })),
      rows: T.rows.map((r) => ({ key: r.key, cells: r.cells })),
    }
    const tq = targets.map((t) => qual(t)).join(', ')
    this.emit(ctx, {
      kind: 'enter',
      detail: 'major',
      title: 'Entra TREATAS',
      explanation: `TREATAS no cambia los valores: los mismos ${pl(T.rows.length, 'valor', 'valores')} de \`${this.text(n.args[0].span, 40)}\` se tratan ahora como valores de ${tq}. Como esa columna pertenece al modelo, usada como filtro de CALCULATE filtra ${tq} sin necesidad de una relación.`,
      span: n.span,
      tables: this.stageOnly([snapshotTable(T, { role: 'working' }), snapshotTable(out, { role: 'filter', highlight: new Set(targets.map((t) => t.column.toLowerCase())) })]),
    })
    return out
  }

  // ---------- relaciones ----------

  /** Camino de relaciones activas desde una tabla (lado muchos) hasta otra (lado uno). */
  private relPath(from: string, to: string, active: boolean[]): number[] | null {
    const queue: { table: string; path: number[] }[] = [{ table: from, path: [] }]
    const seen = new Set([from])
    while (queue.length > 0) {
      const cur = queue.shift() as { table: string; path: number[] }
      for (let i = 0; i < this.rels.length; i++) {
        const r = this.rels[i]
        if (!active[i] || r.fromTable !== cur.table || seen.has(r.toTable)) continue
        const path = [...cur.path, i]
        if (r.toTable === to) return path
        seen.add(r.toTable)
        queue.push({ table: r.toTable, path })
      }
    }
    return null
  }

  private evalRelated(n: CallNode, ctx: Ctx): Value {
    this.arity(n, 1, 1)
    const arg = n.args[0]
    if (arg.type !== 'colRef') {
      throw new EngineError('RELATED espera una columna de otra tabla, por ejemplo RELATED(Productos[Marca]).', arg.span)
    }
    const mc = this.modelColumn(arg)
    const target = mc.table
    const targetQ = qual({ table: target.name, column: target.columns[mc.ci].name })
    if (ctx.rows.length === 0) {
      throw new EngineError(
        `RELATED necesita un contexto de fila: no sabe de qué fila partir para buscar ${targetQ}. Úsala dentro de un iterador o de una función que recorra filas, como ADDCOLUMNS, FILTER o SUMX.`,
        n.span,
      )
    }
    for (let k = ctx.rows.length - 1; k >= 0; k--) {
      const rc = ctx.rows[k]
      const tables = [...new Set(rc.table.cols.filter((c) => c.lineage).map((c) => (c.lineage as { table: string }).table))]
      for (const x of tables) {
        const path = this.relPath(x, target.name, ctx.active)
        if (!path) continue
        const cell = (col: string): Value => {
          const idx = rc.table.cols.findIndex((c) => c.lineage !== null && c.lineage.table === x && c.lineage.column === col)
          return rc.row.cells[idx]
        }
        let keyVal = cell(this.rels[path[0]].fromColumn)
        const firstKey = keyVal
        let found: Value[] | null = null
        let lastTable = target
        for (let j = 0; j < path.length; j++) {
          const r = this.rels[path[j]]
          const tbl = this.tableByName(r.toTable)
          lastTable = tbl
          const tc = this.colPos(tbl, r.toColumn)
          found = tbl.rows.find((row) => normKey(row[tc]) === normKey(keyVal)) ?? null
          if (!found) break
          if (j + 1 < path.length) keyVal = found[this.colPos(tbl, this.rels[path[j + 1]].fromColumn)]
        }
        const value = found ? found[mc.ci] : null
        if (!this.relatedShown.has(n.span.start)) {
          this.relatedShown.add(n.span.start)
          const r0 = this.rels[path[0]]
          const rl = this.rels[path[path.length - 1]]
          const fromQ = qual({ table: r0.fromTable, column: r0.fromColumn })
          const toQ = qual({ table: rl.toTable, column: rl.toColumn })
          const row = found ? lastTable.rows.indexOf(found) : -1
          const full = this.modelTableValue(lastTable, this.allIdx(lastTable))
          this.emit(ctx, {
            kind: 'enter',
            detail: 'major',
            title: `RELATED busca en ${target.name}`,
            explanation: `RELATED toma ${fromQ} de la fila actual (${fmt(firstKey)}), busca ese valor en ${toQ} siguiendo la relación activa${path.length > 1 ? ` (${path.length} relaciones encadenadas)` : ''} y devuelve ${targetQ}: ${fmt(value)}. Solo funciona del lado muchos hacia el lado uno, y esta búsqueda se repite en cada fila.`,
            span: n.span,
            tables: this.stage([
              snapshotTable(full, {
                role: 'source',
                highlight: new Set([rl.toColumn.toLowerCase(), target.columns[mc.ci].name.toLowerCase()]),
                status: full.rows.map((_, q): RowStatus => (q === row ? 'active' : 'normal')),
              }),
            ]),
            used: path,
          })
        }
        return value
      }
    }
    const iter = [...new Set(ctx.rows.map((rc) => rc.table.model ?? rc.table.title))].join(', ')
    throw new EngineError(
      `No hay una relación activa que lleve de ${iter} a ${target.name}, así que RELATED no puede buscar ${targetQ}. RELATED solo funciona desde el lado muchos hacia el lado uno de una relación (por ejemplo, de Ventas a Productos).`,
      n.span,
    )
  }

  private evalRelatedTable(n: CallNode, ctx: Ctx): TableValue {
    this.arity(n, 1, 1)
    const arg = n.args[0]
    if (arg.type !== 'tableRef') {
      throw new EngineError('RELATEDTABLE espera una tabla del modelo, por ejemplo RELATEDTABLE(Ventas).', arg.span)
    }
    const target = this.findTable(arg.name, arg.span)
    if (ctx.rows.length === 0) {
      throw new EngineError(
        `RELATEDTABLE necesita un contexto de fila: no sabe de qué fila partir para traer las filas de ${target.name}. Úsala dentro de un iterador como ADDCOLUMNS o SUMX.`,
        n.span,
      )
    }
    const reachable = ctx.rows.some((rc) =>
      rc.table.cols.some((c) => c.lineage !== null && this.relPath(target.name, c.lineage.table, ctx.active) !== null),
    )
    if (!reachable) {
      const iter = [...new Set(ctx.rows.map((rc) => rc.table.model ?? rc.table.title))].join(', ')
      throw new EngineError(
        `No hay una relación activa que lleve de ${target.name} (lado muchos) a ${iter} (lado uno), así que RELATEDTABLE no puede traer filas de ${target.name}.`,
        n.span,
      )
    }
    const syn: CallNode = { type: 'call', name: 'CALCULATETABLE', nameSpan: n.nameSpan, args: [arg], span: n.span }
    return this.calculate(syn, ctx, true, 'RELATEDTABLE') as TableValue
  }

  // ---------- CALCULATE / CALCULATETABLE ----------

  private calculate(n: CallNode, ctx: Ctx, asTable: boolean, alias?: string): Value | TableValue {
    const name = alias ?? n.name
    this.arity(n, 1, Infinity)
    const exprNode = n.args[0]
    if (asTable && !this.isTableNode(exprNode)) {
      throw new EngineError('El primer argumento de CALCULATETABLE debe ser una tabla. Para un valor único usa CALCULATE.', exprNode.span)
    }
    if (!asTable && this.isTableNode(exprNode)) {
      throw new EngineError('El primer argumento de CALCULATE debe ser un valor, no una tabla. Para devolver una tabla usa CALCULATETABLE.', exprNode.span)
    }
    const specs = n.args.slice(1).map((a) => this.classify(a))
    const filterTexts = n.args.slice(1).map((a) => this.text(a.span, 40))
    const tText = this.text(exprNode.span, 50)
    this.emit(ctx, {
      kind: 'enter',
      detail: 'major',
      title: `Entra ${name}`,
      explanation: alias
        ? `${name}(${tText}) es en realidad CALCULATETABLE(${tText}) disfrazado: no lleva filtros propios, así que todo el trabajo es la transición de contexto. La fila actual se convierte en filtro y, por las relaciones activas, viaja hasta ${tText}.`
        : `${name} no evalúa primero su primer argumento: antes procesa los argumentos de filtro` +
          (filterTexts.length > 0 ? ` (\`${filterTexts.join('\`, \`')}\`)` : '') +
          `, aplica los cambios al contexto de filtro y recién al final evalúa \`${tText}\` con el contexto resultante.`,
      span: n.span,
      tables: this.stage([]),
    })

    // (a) los filtros se evaluan en el contexto original, con las relaciones originales
    const mods: ModSpec[] = []
    const userels: { call: CallNode; ri: number }[] = []
    const explicit: { filter: Filter; keep: boolean; node: Node }[] = []
    for (const s of specs) {
      if (s.kind === 'modifier') mods.push(this.modSpec(s.node as CallNode))
      else if (s.kind === 'userel') userels.push({ call: s.node as CallNode, ri: this.userelIndex(s.node as CallNode) })
      else if (s.kind === 'table') explicit.push({ filter: this.tableFilter(s.node, ctx), keep: s.keep, node: s.node })
      else explicit.push({ filter: this.predicateFilter(s.node, ctx), keep: s.keep, node: s.node })
    }

    let cur = ctx.filters
    let act = ctx.active

    // (b) transicion de contexto
    if (ctx.rows.length > 0) {
      const before = cur
      const origins = new Map<string, FilterOrigin>()
      const hide = new Set<string>()
      const described: string[] = []
      for (const rc of ctx.rows) {
        const cols: FCol[] = []
        const vals: Value[] = []
        rc.table.cols.forEach((c, i) => {
          if (c.lineage) {
            cols.push(c.lineage)
            vals.push(rc.row.cells[i])
          }
        })
        if (cols.length === 0) continue
        const f: Filter = { id: this.newId('F'), cols, rows: [vals] }
        const r = dropColumns(cur, (c) => cols.some((x) => qual(x) === qual(c)), new Set())
        r.removed.forEach((id) => hide.add(id))
        cur = [...r.after, f]
        origins.set(f.id, r.removed.size > 0 || r.modified.size > 0 ? 'replaced' : 'added')
        const d = describeFilter(f).split(', ')
        described.push(d.length > 3 ? d.slice(0, 3).join(', ') + ', ...' : d.join(', '))
      }
      if (described.length > 0) {
        this.transitioned = true
        this.emit(ctx, {
          kind: 'context-transition',
          detail: 'major',
          title: alias ? `Transición de contexto (${name})` : 'Transición de contexto',
          explanation: `Como ${name} se ejecuta dentro de una fila, esa fila se convierte en filtros: ${described.join('; ')}. Desde aquí la expresión ya no ve el contexto de fila, solo estos filtros${alias ? ', que además viajan por las relaciones' : ''}.`,
          span: n.span,
          tables: this.stage([]),
          filters: diffEntries(before, cur, origins, hide),
        })
      }
    }
    const ctx2: Ctx = { filters: cur, rows: [], active: act }

    // (c) modificadores: USERELATIONSHIP, despues ALL / REMOVEFILTERS
    for (const u of userels) {
      const before = act
      const r = this.rels[u.ri]
      act = before.map((a, i) => {
        if (i === u.ri) return true
        const o = this.rels[i]
        const same = (o.fromTable === r.fromTable && o.toTable === r.toTable) || (o.fromTable === r.toTable && o.toTable === r.fromTable)
        return same ? false : a
      })
      ctx2.active = act
      const change = new Map<number, 'activated' | 'deactivated'>()
      const off: string[] = []
      act.forEach((a, i) => {
        if (i === u.ri && !before[i]) change.set(i, 'activated')
        else if (before[i] && !a) {
          change.set(i, 'deactivated')
          off.push(`${this.rels[i].fromTable}[${this.rels[i].fromColumn}] -> ${this.rels[i].toTable}[${this.rels[i].toColumn}]`)
        }
      })
      const rq = `${r.fromTable}[${r.fromColumn}] -> ${r.toTable}[${r.toColumn}]`
      const one = this.tableByName(r.toTable)
      const many = this.tableByName(r.fromTable)
      this.emit(ctx2, {
        kind: 'relationship-change',
        detail: 'major',
        title: 'USERELATIONSHIP cambia la relación',
        explanation: before[u.ri]
          ? `USERELATIONSHIP pide la relación ${rq}, pero esa ya era la activa, así que nada cambia.`
          : `USERELATIONSHIP activa la relación ${rq} mientras se evalúa ${name}.` +
            (off.length > 0 ? ` Entre ${r.fromTable} y ${r.toTable} solo puede haber una relación activa a la vez, por eso se apaga ${off.join(', ')}.` : '') +
            ' Al terminar, el modelo vuelve a su estado original.',
        span: u.call.span,
        tables: this.stage([
          snapshotTable(this.modelTableValue(many, this.allIdx(many)), { role: 'source', highlight: new Set([r.fromColumn.toLowerCase()]) }),
          snapshotTable(this.modelTableValue(one, this.allIdx(one)), { role: 'source', highlight: new Set([r.toColumn.toLowerCase()]) }),
        ]),
        relChange: change,
        used: [u.ri],
      })
    }
    for (const m of mods) {
      const before = cur
      const r = dropColumns(cur, m.drop, new Set())
      cur = r.after
      const n2 = r.removed.size + r.modified.size
      this.emit(ctx2, {
        kind: 'context-change',
        detail: 'major',
        title: `${m.call.name} quita filtros`,
        explanation:
          n2 === 0
            ? `${m.call.name} quita los filtros sobre ${m.what}, pero ahí no había ninguno.`
            : `${m.call.name} quita los filtros sobre ${m.what} del contexto actual: ${n2} ${n2 === 1 ? 'filtro afectado' : 'filtros afectados'}.`,
        span: m.call.span,
        tables: this.stage([]),
        filters: diffEntries(before, cur, new Map(), new Set()),
      })
    }

    // (d) filtros explicitos
    const mine = new Set<string>()
    for (const e of explicit) {
      const before = cur
      const f = e.filter
      const origins = new Map<string, FilterOrigin>()
      const hide = new Set<string>()
      let how: string
      if (e.keep) {
        cur = [...cur, f]
        origins.set(f.id, 'added')
        how = `KEEPFILTERS conserva los filtros que ya había y agrega este: una fila debe cumplir ambos (intersección).`
      } else {
        const r = dropColumns(cur, (c) => f.cols.some((x) => qual(x) === qual(c)), mine)
        r.removed.forEach((id) => hide.add(id))
        cur = [...r.after, f]
        const replaced = r.removed.size > 0 || r.modified.size > 0
        origins.set(f.id, replaced ? 'replaced' : 'added')
        how = replaced
          ? `Este filtro reemplaza al que había sobre ${f.cols.map(qual).join(', ')}: los filtros nuevos tienen prioridad sobre los existentes.`
          : `No había filtros previos sobre ${f.cols.map(qual).join(', ')}, así que simplemente se agrega.`
      }
      mine.add(f.id)
      this.emit(ctx2, {
        kind: 'context-change',
        detail: 'major',
        title: 'Se aplica un filtro',
        explanation: `Filtro: ${describeFilter(f)}. ${how}`,
        span: e.node.span,
        tables: this.stage([]),
        filters: diffEntries(before, cur, origins, hide),
      })
    }

    // (e) la expresion se evalua en el contexto nuevo
    const ctx3: Ctx = { filters: cur, rows: [], active: act }
    this.emit(ctx3, {
      kind: 'context-change',
      detail: 'major',
      title: 'Se evalúa la expresión',
      explanation: `Con el contexto de filtro ya preparado (${cur.length === 0 ? 'sin filtros' : cur.length + (cur.length === 1 ? ' filtro' : ' filtros')}), ahora sí se evalúa \`${this.text(exprNode.span, 60)}\`.`,
      span: exprNode.span,
      tables: this.stage([]),
    })
    const restored = act !== ctx.active ? ' Las relaciones del modelo vuelven a su estado original.' : ''
    if (asTable) {
      const t = this.evalTable(exprNode, ctx3)
      this.emit(ctx, {
        kind: 'table-result',
        detail: 'major',
        title: `${name} devuelve la tabla`,
        explanation: `La tabla resultante tiene ${pl(t.rows.length, 'fila', 'filas')}. El contexto de filtro vuelve a ser el de antes de ${name}.${restored}`,
        span: n.span,
        tables: this.stage([snapshotTable(t, { role: this.roleOf(t) })]),
      })
      return t
    }
    const value = this.evalScalar(exprNode, ctx3)
    this.landing = { node: n, value }
    this.emit(ctx, {
      kind: 'scalar-result',
      detail: 'major',
      title: 'CALCULATE devuelve el valor',
      explanation: `El valor calculado con el contexto nuevo es ${fmt(value)}. Fuera de CALCULATE el contexto vuelve a ser el de antes.${restored}`,
      span: n.span,
      tables: this.stage([]),
      scalar: { label: this.text(n.span, 60), value },
    })
    this.landing = null
    return value
  }

  /** Relacion del modelo que une las dos columnas de USERELATIONSHIP, en cualquier orden. */
  private userelIndex(call: CallNode): number {
    this.arity(call, 2, 2)
    const cols = call.args.map((a) => {
      if (a.type !== 'colRef') {
        throw new EngineError('USERELATIONSHIP espera dos columnas, por ejemplo USERELATIONSHIP(Ventas[FechaEntrega], Calendario[Fecha]).', a.span)
      }
      const mc = this.modelColumn(a)
      return { table: mc.table.name, column: mc.table.columns[mc.ci].name }
    })
    const [a, b] = cols
    const idx = this.rels.findIndex(
      (r) =>
        (r.fromTable === a.table && r.fromColumn === a.column && r.toTable === b.table && r.toColumn === b.column) ||
        (r.fromTable === b.table && r.fromColumn === b.column && r.toTable === a.table && r.toColumn === a.column),
    )
    if (idx < 0) {
      throw new EngineError(
        `En el modelo no existe una relación entre ${qual(a)} y ${qual(b)}, así que USERELATIONSHIP no tiene nada que activar. Solo puede activar relaciones que ya están definidas (aunque estén inactivas).`,
        call.span,
      )
    }
    return idx
  }
}
