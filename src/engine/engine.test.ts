import { describe, it, expect } from 'vitest'
import { run } from './index'
import type { RunResult, Trace, Value } from './index'
import { lex } from './lexer'
import { parse } from './parser'
import { sampleModel } from '../data/sampleModel'
import { examples } from '../data/examples'

function ok(formula: string): Trace {
  const r: RunResult = run(formula, sampleModel)
  if (!r.ok) throw new Error(`${formula} -> ${r.error.message}`)
  return r.trace
}

function scalar(formula: string): Value {
  const t = ok(formula)
  if (t.result.kind !== 'scalar') throw new Error('se esperaba un escalar')
  return t.result.value
}

function table(formula: string): Value[][] {
  const t = ok(formula)
  if (t.result.kind !== 'table') throw new Error('se esperaba una tabla')
  return t.result.table.rows.map((r) => r.cells)
}

function fail(formula: string) {
  const r = run(formula, sampleModel)
  if (r.ok) throw new Error('se esperaba un error')
  return r.error
}

describe('lexer y parser', () => {
  it('lee tokens con posicion y omite comentarios', () => {
    const toks = lex('1 + /* x */ 2 // fin\n-- otro')
    expect(toks.map((t) => t.text)).toEqual(['1', '+', '2', ''])
    expect(toks[2].start).toBe(12)
  })

  it('lee cadenas con comillas dobles escapadas', () => {
    const toks = lex('"a""b"')
    expect(toks[0].text).toBe('a"b')
  })

  it('reporta una cadena sin cerrar con su posicion', () => {
    const e = fail('"abc')
    expect(e.span).toEqual({ start: 0, end: 4 })
  })

  it('respeta la precedencia de operadores', () => {
    expect(scalar('1 + 2 * 3')).toBe(7)
    expect(scalar('(1 + 2) * 3')).toBe(9)
    expect(scalar('-2 * 3')).toBe(-6)
    expect(scalar('"a" & "b" = "ab"')).toBe(true)
    expect(scalar('1 = 1 || 1 = 2 && 1 = 3')).toBe(true)
  })

  it('acepta = y EVALUATE al inicio', () => {
    expect(scalar('= 1 + 1')).toBe(2)
    expect(scalar('EVALUATE 3')).toBe(3)
  })

  it('funciona sin importar mayusculas y con saltos de linea', () => {
    expect(scalar('sum(\n  ventas[cantidad]\n)')).toBe(38)
    expect(scalar("SUM('Ventas'[Cantidad])")).toBe(38)
  })

  it('una funcion desconocida da un error con su posicion', () => {
    const e = fail('1 + FOO(2)')
    expect(e.message).toContain('FOO')
    expect(e.span).toEqual({ start: 4, end: 7 })
  })

  it('un parentesis sin cerrar da error', () => {
    const e = fail('FILTER(Ventas, 1')
    expect(e.span).not.toBeNull()
  })

  it('una tabla inexistente da error con su posicion', () => {
    const e = fail('SUM(Otra[x])')
    expect(e.message).toContain('Otra')
    expect(e.span).toEqual({ start: 4, end: 11 })
  })
})

describe('funciones escalares y agregadores', () => {
  it('agregadores sobre columnas', () => {
    expect(scalar('SUM(Ventas[Cantidad])')).toBe(38)
    expect(scalar('AVERAGE(Ventas[Cantidad])')).toBe(3.8)
    expect(scalar('MIN(Ventas[Cantidad])')).toBe(1)
    expect(scalar('MAX(Ventas[Cantidad])')).toBe(6)
    expect(scalar('COUNT(Ventas[Cantidad])')).toBe(10)
    expect(scalar('DISTINCTCOUNT(Ventas[Producto])')).toBe(5)
    expect(scalar('COUNTROWS(Ventas)')).toBe(10)
  })

  it('iteradores', () => {
    expect(scalar('SUMX(Ventas, Ventas[Cantidad] * Ventas[Precio])')).toBe(231)
    expect(scalar('AVERAGEX(Ventas, Ventas[Cantidad])')).toBe(3.8)
    expect(scalar('MINX(Ventas, Ventas[Precio])')).toBe(2)
    expect(scalar('MAXX(Ventas, Ventas[Precio])')).toBe(13)
    expect(scalar('COUNTX(Ventas, Ventas[Cantidad])')).toBe(10)
  })

  it('IF, AND, OR, NOT, ISBLANK, DIVIDE', () => {
    expect(scalar('IF(1 > 2, "a", "b")')).toBe('b')
    expect(scalar('IF(1 > 2, "a")')).toBeNull()
    expect(scalar('AND(TRUE(), FALSE())')).toBe(false)
    expect(scalar('OR(TRUE, FALSE)')).toBe(true)
    expect(scalar('NOT(TRUE())')).toBe(false)
    expect(scalar('NOT 1 = 2')).toBe(true)
    expect(scalar('ISBLANK(BLANK())')).toBe(true)
    expect(scalar('DIVIDE(6, 3)')).toBe(2)
    expect(scalar('DIVIDE(6, 0)')).toBeNull()
    expect(scalar('DIVIDE(6, 0, -1)')).toBe(-1)
  })

  it('IN con lista y comparacion de texto sin distinguir mayusculas', () => {
    expect(scalar('"aceite" IN {"Aceite", "Arroz"}')).toBe(true)
    expect(scalar('3 IN {1, 2}')).toBe(false)
  })

  it('COUNTROWS de una tabla vacia es BLANK', () => {
    expect(scalar('COUNTROWS(FILTER(Ventas, Ventas[Cantidad] > 100))')).toBeNull()
    expect(scalar('SUMX(FILTER(Ventas, Ventas[Cantidad] > 100), Ventas[Cantidad])')).toBeNull()
  })

  it('un SUM sin filas visibles es BLANK', () => {
    expect(scalar('CALCULATE(SUM(Ventas[Cantidad]), Ventas[Producto] = "Pan")')).toBeNull()
  })
})

describe('funciones de tabla', () => {
  it('FILTER conserva las filas que cumplen y mantiene las claves', () => {
    const t = ok('FILTER(Ventas, Ventas[Cantidad] = 5)')
    if (t.result.kind !== 'table') throw new Error('tabla')
    expect(t.result.table.rows.map((r) => r.key)).toEqual(['0', '3', '5', '7'])
    expect(t.result.table.rows.every((r) => r.status === 'normal')).toBe(true)
  })

  it('FILTER genera un paso por fila con nota y fila activa', () => {
    const t = ok('FILTER(Ventas, Ventas[Cantidad] = 5 && Ventas[Producto] = "Aceite")')
    const rowSteps = t.steps.filter((s) => s.kind === 'iterate-row')
    expect(rowSteps).toHaveLength(10)
    expect(rowSteps.every((s) => s.detail === 'minor')).toBe(true)
    const first = rowSteps[0].tables.find((x) => x.id === 'Ventas')!
    expect(first.rows[0].status).toBe('active')
    expect(first.rows[0].note).toBe('5 = 5 && "Aceite" = "Aceite" -> VERDADERO')
    const second = rowSteps[1].tables.find((x) => x.id === 'Ventas')!
    expect(second.rows[0].status).toBe('kept')
    expect(second.rows[1].note).toContain('FALSO')
    expect(rowSteps[1].rowContext[0].table).toBe('Ventas')
  })

  it('ALL con columnas devuelve combinaciones distintas', () => {
    expect(table('ALL(Ventas[Producto], Ventas[Categoria])')).toHaveLength(5)
    expect(table('ALL(Ventas)')).toHaveLength(10)
  })

  it('ALL ignora el filtro del contexto', () => {
    expect(scalar('CALCULATE(COUNTROWS(ALL(Ventas)), Ventas[Producto] = "Aceite")')).toBe(10)
  })

  it('VALUES y DISTINCT dan valores distintos', () => {
    expect(table('VALUES(Ventas[Producto])').map((r) => r[0])).toEqual(['Aceite', 'Arroz', 'Leche', 'Queso', 'Jabon'])
    expect(table('DISTINCT(Ventas[Categoria])')).toHaveLength(3)
    expect(table('VALUES(Ventas)')).toHaveLength(10)
  })

  it('VALUES respeta el filtro del contexto', () => {
    expect(scalar('CALCULATE(COUNTROWS(VALUES(Ventas[Producto])), Ventas[Categoria] = "Lacteos")')).toBe(2)
  })

  it('ADDCOLUMNS y SELECTCOLUMNS', () => {
    const rows = table('ADDCOLUMNS(FILTER(Ventas, Ventas[IdVenta] <= 2), "Importe", Ventas[Cantidad] * Ventas[Precio])')
    expect(rows.map((r) => r[8])).toEqual([60, 12])
    const sel = table('SELECTCOLUMNS(FILTER(Ventas, Ventas[IdVenta] <= 2), "P", Ventas[Producto], "Doble", Ventas[Cantidad] * 2)')
    expect(sel).toEqual([
      ['Aceite', 10],
      ['Arroz', 6],
    ])
  })

  it('la columna calculada se resuelve sin tabla', () => {
    const rows = table('FILTER(ADDCOLUMNS(Ventas, "Imp", Ventas[Cantidad] * Ventas[Precio]), [Imp] > 50)')
    expect(rows.map((r) => r[0])).toEqual([1, 6])
  })
})

describe('CALCULATE y CALCULATETABLE', () => {
  it('CALCULATETABLE con predicado devuelve las ventas 1 y 6', () => {
    const rows = table('CALCULATETABLE(Ventas, Ventas[Cantidad] = 5 && Ventas[Producto] = "Aceite")')
    expect(rows.map((r) => r[0])).toEqual([1, 6])
  })

  it('el predicado tiene un paso de reescritura con FILTER(ALL(...))', () => {
    const t = ok('CALCULATETABLE(Ventas, Ventas[Cantidad] = 5 && Ventas[Producto] = "Aceite")')
    const rw = t.steps.find((s) => s.kind === 'rewrite')!
    expect(rw.explanation).toContain('`FILTER(ALL(Ventas[Cantidad], Ventas[Producto]),')
    expect(rw.tables.some((x) => x.role === 'filter')).toBe(true)
    const kinds = t.steps.map((s) => s.kind)
    expect(kinds[0]).toBe('start')
    expect(kinds[kinds.length - 1]).toBe('result')
    expect(kinds).toContain('apply-filters')
    const enter = t.steps.find((s) => s.kind === 'enter')!
    expect(enter.explanation).toContain('al final')
  })

  it('CALCULATE con predicado', () => {
    expect(scalar('CALCULATE(SUM(Ventas[Cantidad]), Ventas[Producto] = "Aceite")')).toBe(12)
  })

  it('un filtro de tabla funciona como filtro', () => {
    expect(scalar('CALCULATE(SUM(Ventas[Cantidad]), FILTER(ALL(Ventas[Producto]), Ventas[Producto] = "Queso"))')).toBe(1)
    expect(scalar('CALCULATE(SUM(Ventas[Cantidad]), VALUES(Ventas[Categoria]))')).toBe(38)
  })

  const outer = 'Ventas[Producto] IN {"Aceite", "Arroz"}'

  it('un filtro explicito reemplaza al existente', () => {
    expect(scalar(`CALCULATE(CALCULATE(SUM(Ventas[Cantidad]), Ventas[Producto] = "Leche"), ${outer})`)).toBe(7)
  })

  it('KEEPFILTERS intersecta con el existente', () => {
    expect(scalar(`CALCULATE(CALCULATE(SUM(Ventas[Cantidad]), KEEPFILTERS(Ventas[Producto] = "Leche")), ${outer})`)).toBeNull()
    expect(scalar(`CALCULATE(CALCULATE(SUM(Ventas[Cantidad]), KEEPFILTERS(Ventas[Producto] = "Arroz")), ${outer})`)).toBe(8)
  })

  it('marca el origen de los filtros en los pasos de contexto', () => {
    const t = ok(`CALCULATE(CALCULATE(SUM(Ventas[Cantidad]), Ventas[Producto] = "Leche"), ${outer})`)
    const changes = t.steps.filter((s) => s.kind === 'context-change' && s.filterContext.some((f) => f.origin === 'replaced'))
    expect(changes).toHaveLength(1)
    const idx = t.steps.indexOf(changes[0])
    const next = t.steps[idx + 1]
    expect(next.filterContext.every((f) => f.origin === 'existing')).toBe(true)
  })

  it('ALL y REMOVEFILTERS quitan filtros', () => {
    expect(scalar('CALCULATE(CALCULATE(SUM(Ventas[Cantidad]), ALL(Ventas[Producto])), Ventas[Producto] = "Aceite")')).toBe(38)
    expect(scalar('CALCULATE(CALCULATE(SUM(Ventas[Cantidad]), REMOVEFILTERS()), Ventas[Producto] = "Aceite")')).toBe(38)
    expect(scalar('CALCULATE(CALCULATE(SUM(Ventas[Cantidad]), REMOVEFILTERS(Ventas)), Ventas[Producto] = "Aceite")')).toBe(38)
  })

  it('transicion de contexto: total por producto', () => {
    const rows = table('ADDCOLUMNS(VALUES(Ventas[Producto]), "Total", CALCULATE(SUM(Ventas[Cantidad])))')
    expect(rows).toEqual([
      ['Aceite', 12],
      ['Arroz', 8],
      ['Leche', 7],
      ['Queso', 1],
      ['Jabon', 10],
    ])
    const t = ok('ADDCOLUMNS(VALUES(Ventas[Producto]), "Total", CALCULATE(SUM(Ventas[Cantidad])))')
    const tr = t.steps.find((s) => s.kind === 'context-transition')!
    expect(tr.filterContext.some((f) => f.origin === 'added')).toBe(true)
  })

  it('sin CALCULATE cada fila muestra el total general', () => {
    const rows = table('ADDCOLUMNS(VALUES(Ventas[Producto]), "Total", SUM(Ventas[Cantidad]))')
    expect(rows.map((r) => r[1])).toEqual([38, 38, 38, 38, 38])
  })

  it('la transicion dentro de FILTER usa el contexto de fila', () => {
    const rows = table('FILTER(VALUES(Ventas[Producto]), CALCULATE(SUM(Ventas[Cantidad])) > 9)')
    expect(rows.map((r) => r[0])).toEqual(['Aceite', 'Jabon'])
  })

  it('un predicado sin columnas o con agregaciones da error', () => {
    expect(fail('CALCULATE(SUM(Ventas[Cantidad]), 1 = 1)').message).toContain('columna')
    expect(fail('CALCULATE(SUM(Ventas[Cantidad]), Ventas[Cantidad] > SUM(Ventas[Precio]))').message).toContain('SUM')
  })
})

describe('errores de evaluacion', () => {
  it('una columna sin contexto de fila da el error didactico', () => {
    const e = fail('Ventas[Cantidad]')
    expect(e.message).toContain('contexto de fila')
    expect(e.message).toContain('SUM(Ventas[Cantidad])')
    expect(e.span).toEqual({ start: 0, end: 16 })
  })

  it('una tabla donde se espera un valor da error', () => {
    expect(fail('1 + Ventas').span).toEqual({ start: 4, end: 10 })
  })

  it('la division entre cero con / da error', () => {
    expect(fail('1 / 0').message).toContain('DIVIDE')
  })

  it('demasiados pasos devuelve un error', () => {
    const big = 'COUNTROWS(FILTER(Ventas, COUNTROWS(FILTER(Ventas, COUNTROWS(FILTER(Ventas, COUNTROWS(FILTER(Ventas, Ventas[Cantidad] > 0)) > 0)) > 0)) > 0))'
    const r = run(big, sampleModel)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('demasiados pasos')
  })
})

describe('ejemplos', () => {
  for (const ex of examples) {
    it(`${ex.id} se ejecuta con una traza coherente`, () => {
      const r = run(ex.formula, sampleModel)
      if (!r.ok) throw new Error(r.error.message)
      const steps = r.trace.steps
      expect(steps[0].kind).toBe('start')
      expect(steps[steps.length - 1].kind).toBe('result')
      for (const s of steps) {
        if (s.span) {
          expect(s.span.start).toBeGreaterThanOrEqual(0)
          expect(s.span.end).toBeLessThanOrEqual(ex.formula.length)
          expect(s.span.start).toBeLessThanOrEqual(s.span.end)
        }
        expect(s.tables.length).toBeLessThanOrEqual(3)
        const ids = s.tables.map((x) => x.id)
        expect(new Set(ids).size).toBe(ids.length)
      }
    })
  }

  it('parse produce un arbol para cada ejemplo', () => {
    for (const ex of examples) expect(() => parse(ex.formula)).not.toThrow()
  })
})

describe('escenario fijo durante la iteracion', () => {
  function checkPinned(formula: string, pinnedId: (id: string) => boolean) {
    const t = ok(formula)
    const first = t.steps.findIndex((s) => s.kind === 'iterate-row' || s.kind === 'context-transition')
    const last = t.steps.findIndex((s) => (s.kind === 'table-result' || s.kind === 'aggregate') && s.span?.start === 0)
    const end = last > 0 ? last : t.steps.length - 1
    expect(end).toBeGreaterThan(first)
    for (let i = first; i < end; i++) {
      const s = t.steps[i]
      const pinned = s.tables.filter((x) => pinnedId(x.id))
      expect(pinned.length, `paso ${i} ${s.kind}`).toBe(1)
      expect(pinned[0].rows.filter((r) => r.status === 'active'), `paso ${i} ${s.kind}`).toHaveLength(1)
    }
    return t
  }

  it('ADDCOLUMNS con CALCULATE mantiene la tabla de VALUES y muestra el valor', () => {
    const t = checkPinned(
      'ADDCOLUMNS(VALUES(Ventas[Producto]), "Total", CALCULATE(SUM(Ventas[Cantidad])))',
      (id) => id.startsWith('VALUES@'),
    )
    const landed = t.steps.find((s) => s.kind === 'scalar-result')!
    const row = landed.tables.find((x) => x.id.startsWith('VALUES@'))!.rows.find((r) => r.status === 'active')!
    expect(row.cells[1]).toBe(12)
    expect(row.note).toBe('Total = 12')
    expect(landed.rowContext).toHaveLength(1)
  })

  it('SUMX con CALCULATE mantiene la tabla iterada', () => {
    checkPinned('SUMX(Ventas, CALCULATE(SUM(Ventas[Cantidad])))', (id) => id === 'Ventas')
  })

  it('usa singular cuando hay una sola fila', () => {
    const t = ok('CALCULATE(SUM(Ventas[Cantidad]), Ventas[Producto] = "Queso")')
    expect(t.steps.some((s) => s.explanation.includes('en la única fila visible'))).toBe(true)
    expect(t.steps.some((s) => s.title === 'Queda 1 de 9 combinaciones')).toBe(false)
  })
})
