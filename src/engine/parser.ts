import type { SourceSpan } from './types'
import { EngineError } from './errors'
import { lex } from './lexer'
import type { Token } from './lexer'

interface Base {
  span: SourceSpan
}

export interface NumNode extends Base {
  type: 'num'
  value: number
}
export interface StrNode extends Base {
  type: 'str'
  value: string
}
export interface BoolNode extends Base {
  type: 'bool'
  value: boolean
}
export interface BlankNode extends Base {
  type: 'blank'
}
export interface TableRefNode extends Base {
  type: 'tableRef'
  name: string
}
export interface ColRefNode extends Base {
  type: 'colRef'
  table: string | null
  column: string
}
export interface UnaryNode extends Base {
  type: 'unary'
  op: '-' | 'NOT'
  arg: Node
}
export interface BinaryNode extends Base {
  type: 'binary'
  op: string
  left: Node
  right: Node
}
export interface InNode extends Base {
  type: 'in'
  left: Node
  /** Elementos de { ... } o, si list es false, una unica expresion de tabla. */
  items: Node[]
  list: boolean
}
export interface CallNode extends Base {
  type: 'call'
  /** Nombre en mayusculas. */
  name: string
  nameSpan: SourceSpan
  args: Node[]
}

export type Node =
  | NumNode
  | StrNode
  | BoolNode
  | BlankNode
  | TableRefNode
  | ColRefNode
  | UnaryNode
  | BinaryNode
  | InNode
  | CallNode

export const AGG_COLUMN = new Set(['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'DISTINCTCOUNT'])
export const ITERATORS = new Set(['SUMX', 'AVERAGEX', 'MINX', 'MAXX', 'COUNTX'])
export const TABLE_FUNCS = new Set([
  'FILTER',
  'ALL',
  'VALUES',
  'DISTINCT',
  'CALCULATETABLE',
  'ADDCOLUMNS',
  'SELECTCOLUMNS',
  'RELATEDTABLE',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'CROSSJOIN',
  'TREATAS',
])
/** Funciones que se evaluan fila a fila sin cambiar contextos. */
export const ROW_LEVEL = new Set(['IF', 'AND', 'OR', 'NOT', 'ISBLANK', 'DIVIDE', 'TRUE', 'FALSE', 'BLANK', 'DATE', 'RELATED'])
const OTHERS = new Set(['COUNTROWS', 'CALCULATE', 'REMOVEFILTERS', 'KEEPFILTERS', 'USERELATIONSHIP'])

/** Nombres de todas las funciones que el motor sabe evaluar. */
export const SUPPORTED_FUNCTIONS: string[] = [
  ...AGG_COLUMN,
  ...ITERATORS,
  ...TABLE_FUNCS,
  ...ROW_LEVEL,
  ...OTHERS,
]

export function isKnownFunction(name: string): boolean {
  return AGG_COLUMN.has(name) || ITERATORS.has(name) || TABLE_FUNCS.has(name) || ROW_LEVEL.has(name) || OTHERS.has(name)
}

export function children(n: Node): Node[] {
  switch (n.type) {
    case 'unary':
      return [n.arg]
    case 'binary':
      return [n.left, n.right]
    case 'in':
      return [n.left, ...n.items]
    case 'call':
      return n.args
    default:
      return []
  }
}

export function walk(n: Node, f: (x: Node) => void): void {
  f(n)
  for (const c of children(n)) walk(c, f)
}

const COMPARISON = ['=', '==', '<>', '<', '<=', '>', '>=']

/** Convierte el texto de la formula en un arbol con la posicion de cada parte. */
export function parse(src: string): Node {
  const toks = lex(src)
  let p = 0

  const peek = (): Token => toks[p]
  const isPunct = (t: Token, s: string): boolean => t.kind === 'punct' && t.text === s
  const isOp = (t: Token, s: string): boolean => t.kind === 'op' && t.text === s
  const isKw = (t: Token, s: string): boolean => t.kind === 'ident' && t.text.toUpperCase() === s

  const describe = (t: Token): string => (t.kind === 'eof' ? 'el final de la fórmula' : `'${src.slice(t.start, t.end)}'`)
  const fail = (msg: string, t: Token): never => {
    throw new EngineError(msg, { start: t.start, end: t.end })
  }

  if (isOp(toks[0], '=')) p++
  else if (isKw(toks[0], 'EVALUATE') && !isPunct(toks[1], '(')) p++

  if (peek().kind === 'eof') {
    throw new EngineError('Escribe una fórmula DAX para poder evaluarla.', null)
  }

  function parseOr(): Node {
    let left = parseAnd()
    while (isOp(peek(), '||')) {
      p++
      const right = parseAnd()
      left = { type: 'binary', op: '||', left, right, span: { start: left.span.start, end: right.span.end } }
    }
    return left
  }

  function parseAnd(): Node {
    let left = parseNot()
    while (isOp(peek(), '&&')) {
      p++
      const right = parseNot()
      left = { type: 'binary', op: '&&', left, right, span: { start: left.span.start, end: right.span.end } }
    }
    return left
  }

  function parseNot(): Node {
    const t = peek()
    if (isKw(t, 'NOT')) {
      p++
      const arg = parseNot()
      return { type: 'unary', op: 'NOT', arg, span: { start: t.start, end: arg.span.end } }
    }
    return parseComparison()
  }

  function parseComparison(): Node {
    let left = parseConcat()
    for (;;) {
      const t = peek()
      if (t.kind === 'op' && COMPARISON.includes(t.text)) {
        p++
        const right = parseConcat()
        left = { type: 'binary', op: t.text, left, right, span: { start: left.span.start, end: right.span.end } }
      } else if (isKw(t, 'IN')) {
        p++
        if (isPunct(peek(), '{')) {
          p++
          const items: Node[] = []
          if (!isPunct(peek(), '}')) {
            for (;;) {
              items.push(parseOr())
              if (isPunct(peek(), ',')) {
                p++
                continue
              }
              break
            }
          }
          const close = peek()
          if (!isPunct(close, '}')) fail(`Se esperaba '}' pero se encontró ${describe(close)}.`, close)
          p++
          left = { type: 'in', left, items, list: true, span: { start: left.span.start, end: close.end } }
        } else {
          const right = parseConcat()
          left = { type: 'in', left, items: [right], list: false, span: { start: left.span.start, end: right.span.end } }
        }
      } else {
        return left
      }
    }
  }

  function parseConcat(): Node {
    let left = parseAdd()
    while (isOp(peek(), '&')) {
      p++
      const right = parseAdd()
      left = { type: 'binary', op: '&', left, right, span: { start: left.span.start, end: right.span.end } }
    }
    return left
  }

  function parseAdd(): Node {
    let left = parseMul()
    for (;;) {
      const t = peek()
      if (isOp(t, '+') || isOp(t, '-')) {
        p++
        const right = parseMul()
        left = { type: 'binary', op: t.text, left, right, span: { start: left.span.start, end: right.span.end } }
      } else {
        return left
      }
    }
  }

  function parseMul(): Node {
    let left = parseUnary()
    for (;;) {
      const t = peek()
      if (isOp(t, '*') || isOp(t, '/')) {
        p++
        const right = parseUnary()
        left = { type: 'binary', op: t.text, left, right, span: { start: left.span.start, end: right.span.end } }
      } else {
        return left
      }
    }
  }

  function parseUnary(): Node {
    const t = peek()
    if (isOp(t, '-')) {
      p++
      const arg = parseUnary()
      return { type: 'unary', op: '-', arg, span: { start: t.start, end: arg.span.end } }
    }
    if (isOp(t, '+')) {
      p++
      return parseUnary()
    }
    return parsePrimary()
  }

  function parsePrimary(): Node {
    const t = peek()
    switch (t.kind) {
      case 'num':
        p++
        return { type: 'num', value: t.num ?? 0, span: { start: t.start, end: t.end } }
      case 'str':
        p++
        return { type: 'str', value: t.text, span: { start: t.start, end: t.end } }
      case 'bracket':
        p++
        return { type: 'colRef', table: null, column: t.text, span: { start: t.start, end: t.end } }
      case 'qident': {
        p++
        const nx = peek()
        if (nx.kind === 'bracket') {
          p++
          return { type: 'colRef', table: t.text, column: nx.text, span: { start: t.start, end: nx.end } }
        }
        return { type: 'tableRef', name: t.text, span: { start: t.start, end: t.end } }
      }
      case 'ident': {
        p++
        const nx = peek()
        const up = t.text.toUpperCase()
        if (isPunct(nx, '(')) {
          p++
          const args: Node[] = []
          if (!isPunct(peek(), ')')) {
            for (;;) {
              args.push(parseOr())
              if (isPunct(peek(), ',')) {
                p++
                continue
              }
              break
            }
          }
          const close = peek()
          if (!isPunct(close, ')')) {
            fail(`Falta cerrar el paréntesis de ${up}: se encontró ${describe(close)}.`, close.kind === 'eof' ? nx : close)
          }
          p++
          return {
            type: 'call',
            name: up,
            nameSpan: { start: t.start, end: t.end },
            args,
            span: { start: t.start, end: close.end },
          }
        }
        if (up === 'TRUE' || up === 'FALSE') {
          return { type: 'bool', value: up === 'TRUE', span: { start: t.start, end: t.end } }
        }
        if (nx.kind === 'bracket') {
          p++
          return { type: 'colRef', table: t.text, column: nx.text, span: { start: t.start, end: nx.end } }
        }
        return { type: 'tableRef', name: t.text, span: { start: t.start, end: t.end } }
      }
      case 'punct':
        if (t.text === '(') {
          p++
          const inner = parseOr()
          const close = peek()
          if (!isPunct(close, ')')) fail(`Falta cerrar el paréntesis: se encontró ${describe(close)}.`, close.kind === 'eof' ? t : close)
          p++
          return inner
        }
        return fail(`No se esperaba ${describe(t)} aquí.`, t)
      default:
        return fail(`Se esperaba una expresión pero se encontró ${describe(t)}.`, t)
    }
  }

  const root = parseOr()
  const rest = peek()
  if (rest.kind !== 'eof') {
    fail(`Sobra texto después de la expresión: ${describe(rest)}.`, rest)
  }

  walk(root, (x) => {
    if (x.type === 'call' && !isKnownFunction(x.name)) {
      throw new EngineError(`La función ${x.name} todavía no está soportada.`, x.nameSpan)
    }
  })
  return root
}
