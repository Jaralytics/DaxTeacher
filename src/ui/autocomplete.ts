// Logica pura del autocompletado y la ayuda de firma. Sin dependencias del DOM.
import type { FunctionDoc } from '../data/functions'

export type SuggestionKind = 'función' | 'tabla' | 'columna'

export interface ModelTable {
  name: string
  columns: { name: string; type: string }[]
}

export interface Suggestion {
  kind: SuggestionKind
  /** Texto que se muestra en la lista. */
  label: string
  /** Texto que se inserta. */
  insert: string
  /** Sintaxis (solo funciones). */
  detail?: string
  /** Descripcion corta para el pie de la lista. */
  description: string
}

interface Frame {
  type: 'paren' | 'brace'
  name: string | null
  argIndex: number
}

interface ScanState {
  inString: boolean
  inQuoted: boolean
  inComment: boolean
  /** Indice del `[` abierto sin cerrar, si el cursor esta dentro de un corchete. */
  bracketStart: number | null
  stack: Frame[]
}

const WORD_CHAR = /[\p{L}\p{N}_]/u
const WORD_AT_END = /[\p{L}_][\p{L}\p{N}_]*$/u

function nameBefore(text: string, index: number): string | null {
  const m = /([\p{L}_][\p{L}\p{N}_]*)\s*$/u.exec(text.slice(0, index))
  return m ? m[1] : null
}

/** Recorre el texto hasta el cursor para saber en que contexto sintactico esta. */
export function scan(text: string, caret: number): ScanState {
  const state: ScanState = { inString: false, inQuoted: false, inComment: false, bracketStart: null, stack: [] }
  const n = Math.min(caret, text.length)
  let i = 0
  while (i < n) {
    const c = text[i]
    const next = text[i + 1]
    if ((c === '/' && next === '/') || (c === '-' && next === '-')) {
      let j = i
      while (j < n && text[j] !== '\n') j++
      if (j >= n) {
        state.inComment = true
        return state
      }
      i = j + 1
      continue
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end < 0 || end + 2 > n) {
        state.inComment = true
        return state
      }
      i = end + 2
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let closed = false
      while (j < n) {
        if (text[j] === c) {
          if (text[j + 1] === c && j + 1 < n) {
            j += 2
            continue
          }
          closed = true
          break
        }
        j++
      }
      if (!closed) {
        if (c === '"') state.inString = true
        else state.inQuoted = true
        return state
      }
      i = j + 1
      continue
    }
    if (c === '[') {
      let j = i + 1
      let closed = false
      while (j < n) {
        if (text[j] === ']') {
          if (text[j + 1] === ']' && j + 1 < n) {
            j += 2
            continue
          }
          closed = true
          break
        }
        j++
      }
      if (!closed) {
        state.bracketStart = i
        return state
      }
      i = j + 1
      continue
    }
    if (c === '(') state.stack.push({ type: 'paren', name: nameBefore(text, i), argIndex: 0 })
    else if (c === '{') state.stack.push({ type: 'brace', name: null, argIndex: 0 })
    else if (c === ')' || c === '}') state.stack.pop()
    else if (c === ',') {
      const top = state.stack[state.stack.length - 1]
      if (top && top.type === 'paren') top.argIndex++
    }
    i++
  }
  return state
}

export interface CompletionContext {
  mode: 'word' | 'column'
  /** Tabla indicada antes del corchete (`Ventas[`), o null. */
  table: string | null
  /** Texto ya escrito que se usa para filtrar. */
  prefix: string
  /** Donde empieza el texto que se reemplaza al aceptar. */
  replaceStart: number
  /** Donde termina (incluye el resto de la palabra tras el cursor). */
  replaceEnd: number
  /** Ya hay un `]` justo despues del cursor. */
  hasClosing: boolean
}

/**
 * Determina que se esta escribiendo en el cursor. Devuelve null si no corresponde
 * sugerir nada (cadena, comentario, sin identificador). `explicit` permite
 * mostrar sugerencias sin texto escrito (Ctrl+Espacio).
 */
export function getCompletionContext(text: string, caret: number, explicit = false): CompletionContext | null {
  const st = scan(text, caret)
  if (st.inString || st.inQuoted || st.inComment) return null

  if (st.bracketStart !== null) {
    const before = text.slice(0, st.bracketStart)
    const q = /'((?:[^']|'')+)'$/.exec(before)
    const m = q ? null : /([\p{L}_][\p{L}\p{N}_]*)$/u.exec(before)
    const table = q ? q[1].replace(/''/g, "'") : m ? m[1] : null
    const start = st.bracketStart + 1
    return {
      mode: 'column',
      table,
      prefix: text.slice(start, caret),
      replaceStart: start,
      replaceEnd: caret,
      hasClosing: text[caret] === ']',
    }
  }

  const m = WORD_AT_END.exec(text.slice(0, caret))
  // Un identificador pegado a un numero (`5a`) no es un nombre.
  if (m && m.index > 0 && /[0-9]/.test(text[m.index - 1])) return null
  if (!m && !explicit) return null
  if (!m && caret > 0 && WORD_CHAR.test(text[caret - 1])) return null
  const start = m ? m.index : caret
  let end = caret
  while (end < text.length && WORD_CHAR.test(text[end])) end++
  return {
    mode: 'word',
    table: null,
    prefix: m ? m[0] : '',
    replaceStart: start,
    replaceEnd: end,
    hasClosing: false,
  }
}

const KIND_ORDER: Record<SuggestionKind, number> = { función: 0, tabla: 1, columna: 2 }

function quoteTable(name: string): string {
  return /\s/.test(name) || !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) ? `'${name.replace(/'/g, "''")}'` : name
}

function typeLabel(type: string): string {
  if (type === 'date') return 'fecha'
  return type === 'number' ? 'número' : type === 'boolean' ? 'lógico' : 'texto'
}

function firstSentence(text: string): string {
  const m = /^.*?[.!?](?:\s|$)/.exec(text)
  return (m ? m[0] : text).trim()
}

/** Rango de coincidencia: 0 prefijo, 1 subcadena, -1 no coincide. */
function matchRank(candidate: string, prefix: string): number {
  if (!prefix) return 0
  const c = candidate.toLowerCase()
  const p = prefix.toLowerCase()
  if (c.startsWith(p)) return 0
  return c.includes(p) ? 1 : -1
}

export function getSuggestions(
  ctx: CompletionContext,
  catalog: FunctionDoc[],
  tables: ModelTable[],
): Suggestion[] {
  const scored: { s: Suggestion; rank: number }[] = []
  const push = (s: Suggestion, rank: number) => {
    if (rank >= 0) scored.push({ s, rank })
  }

  const columnSuggestion = (t: ModelTable, col: ModelTable['columns'][number], qualified: boolean): Suggestion => {
    const name = col.name.replace(/]/g, ']]')
    const description = `Columna de ${typeLabel(col.type)} de la tabla ${t.name}.`
    if (qualified) {
      return {
        kind: 'columna',
        label: `${quoteTable(t.name)}[${col.name}]`,
        insert: `${quoteTable(t.name)}[${name}]`,
        description,
      }
    }
    return { kind: 'columna', label: col.name, insert: ctx.hasClosing ? name : `${name}]`, description }
  }

  if (ctx.mode === 'column') {
    const wanted = ctx.table?.toLowerCase() ?? null
    const pool = tables.filter((t) => wanted === null || t.name.toLowerCase() === wanted)
    for (const t of pool) {
      for (const col of t.columns) push(columnSuggestion(t, col, false), matchRank(col.name, ctx.prefix))
    }
  } else {
    for (const f of catalog) {
      push(
        {
          kind: 'función',
          label: f.name,
          insert: `${f.name}(`,
          detail: f.syntax,
          description: firstSentence(f.description),
        },
        matchRank(f.name, ctx.prefix),
      )
    }
    for (const t of tables) {
      push(
        {
          kind: 'tabla',
          label: t.name,
          insert: quoteTable(t.name),
          description: `Tabla del modelo con ${t.columns.length} columnas.`,
        },
        matchRank(t.name, ctx.prefix),
      )
    }
    for (const t of tables) {
      for (const col of t.columns) {
        push(columnSuggestion(t, col, true), matchRank(col.name, ctx.prefix))
      }
    }
  }

  scored.sort(
    (a, b) =>
      a.rank - b.rank ||
      KIND_ORDER[a.s.kind] - KIND_ORDER[b.s.kind] ||
      a.s.label.localeCompare(b.s.label, 'es'),
  )
  return scored.map((x) => x.s)
}

/** Aplica una sugerencia y devuelve el texto nuevo y la posicion del cursor. */
export function applySuggestion(
  text: string,
  ctx: CompletionContext,
  suggestion: Suggestion,
): { value: string; caret: number } {
  let insert = suggestion.insert
  const end = ctx.replaceEnd
  // Si ya hay `(` tras el nombre, no se duplica; el cursor la salta.
  const skipParen = suggestion.kind === 'función' && text[end] === '('
  if (skipParen) insert = insert.slice(0, -1)
  // Si ya hay `]` tras el cursor (la sugerencia no lo incluye), el cursor lo salta.
  const skipBracket = ctx.mode === 'column' && ctx.hasClosing
  const value = text.slice(0, ctx.replaceStart) + insert + text.slice(end)
  const caret = ctx.replaceStart + insert.length + (skipParen || skipBracket ? 1 : 0)
  return { value, caret }
}

export interface SignatureContext {
  doc: FunctionDoc
  argIndex: number
}

/** Funcion cuya llamada contiene el cursor y el indice del argumento actual. */
export function getSignatureContext(text: string, caret: number, catalog: FunctionDoc[]): SignatureContext | null {
  const st = scan(text, caret)
  if (st.inString || st.inQuoted || st.inComment) return null
  for (let i = st.stack.length - 1; i >= 0; i--) {
    const f = st.stack[i]
    if (f.type !== 'paren' || !f.name) continue
    const doc = catalog.find((d) => d.name === f.name!.toUpperCase())
    if (doc) return { doc, argIndex: f.argIndex }
  }
  return null
}

export interface SignatureParts {
  name: string
  parts: string[]
  active: number
}

/** Separa la sintaxis de una funcion en sus parametros y decide cual resaltar. */
export function signatureParts(doc: FunctionDoc, argIndex: number): SignatureParts {
  const open = doc.syntax.indexOf('(')
  const close = doc.syntax.lastIndexOf(')')
  const inner = doc.syntax.slice(open + 1, close).replace(/[[\]]/g, '')
  const parts = inner
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const repeats = parts[parts.length - 1] === '...'
  const real = repeats ? parts.length - 1 : parts.length
  let active = argIndex
  if (active >= real) active = repeats ? real - 1 : -1
  if (real === 0) active = -1
  return { name: doc.name, parts, active }
}
