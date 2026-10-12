import { describe, it, expect } from 'vitest'
import { run } from './index'
import type { Trace, Value } from './index'
import { sampleModel } from '../data/sampleModel'
import { examples } from '../data/examples'

function ok(formula: string): Trace {
  const r = run(formula, sampleModel)
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

const find = (id: string) => examples.find((e) => e.id === id)!.formula

describe('escalares de dos tablas', () => {
  it('resta ventas y devoluciones con un paso combine', () => {
    const t = ok('SUM(Ventas[Cantidad]) - SUM(Devoluciones[Cantidad])')
    expect(t.result).toEqual({ kind: 'scalar', value: 31 })
    const idx = t.steps.findIndex((s) => s.kind === 'combine')
    expect(idx).toBeGreaterThan(-1)
    const step = t.steps[idx]
    expect(step.partials).toHaveLength(2)
    expect(step.partials!.map((p) => p.sourceTable)).toEqual(['Ventas', 'Devoluciones'])
    expect(step.partials!.map((p) => p.value)).toEqual([38, 7])
    expect(step.scalar?.value).toBe(31)
    expect(step.explanation).toContain('38 - 7 = 31')
    expect(step.explanation).toContain('Devoluciones')
    const ids = step.tables.map((x) => x.id)
    expect(ids).toContain('Ventas')
    expect(ids).toContain('Devoluciones')
    // despues del combine no quedan parciales
    for (const s of t.steps.slice(idx + 1)) expect(s.partials).toBeUndefined()
    // mientras se evalua el segundo operando, la primera tabla no se queda en escena
    const second = t.steps.filter((s) => s.partials && s.partials.length === 1 && s.kind !== 'combine')
    expect(second.length).toBeGreaterThan(0)
    for (const s of second) expect(s.tables.map((x) => x.id)).not.toContain('Ventas')
  })

  it('DIVIDE e IF con operandos de dos tablas', () => {
    expect(scalar('DIVIDE(SUM(Devoluciones[Cantidad]), SUM(Ventas[Cantidad]))')).toBeCloseTo(0.1842105263, 8)
    expect(scalar('IF(SUM(Devoluciones[Cantidad]) > SUM(Ventas[Cantidad]) / 10, "alta", "baja")')).toBe('alta')
    const t = ok('DIVIDE(SUM(Devoluciones[Cantidad]), SUM(Ventas[Cantidad]))')
    expect(t.steps.filter((s) => s.kind === 'combine')).toHaveLength(1)
  })

  it('la aritmetica por fila dentro de un iterador no genera combine', () => {
    const t = ok('SUMX(Ventas, Ventas[Cantidad] * Ventas[Precio])')
    expect(t.steps.some((s) => s.kind === 'combine')).toBe(false)
  })

  it('el filtro de un proveedor viaja a las dos tablas de hechos', () => {
    const f = find('dos-tablas-proveedor')
    const t = ok(f)
    expect(t.result).toEqual({ kind: 'scalar', value: 16 })
    const props = t.steps.filter((s) => s.kind === 'propagate')
    const targets = props.map((s) => s.tables.map((x) => x.id).filter((id) => id === 'Ventas' || id === 'Devoluciones'))
    expect(targets.flat()).toContain('Ventas')
    expect(targets.flat()).toContain('Devoluciones')
    const usedIdx = props.map((s) => s.relationships.findIndex((r) => r.used))
    expect(new Set(usedIdx).size).toBe(2)
    expect(usedIdx).toContain(0)
    expect(usedIdx).toContain(3)
  })

  it('ADDCOLUMNS con tres columnas de dos tablas de hechos', () => {
    const rows = table(find('dos-tablas-producto'))
    expect(rows).toEqual([
      ['Aceite', 12, 3, 9],
      ['Arroz', 8, 1, 7],
      ['Leche', 7, 2, 5],
      ['Queso', 1, null, 1],
      ['Jabon', 10, 1, 9],
    ])
    expect(table(find('dos-tablas-mes'))).toEqual([
      ['Enero', 15, 1, 14],
      ['Febrero', 15, 3, 12],
      ['Marzo', 8, 3, 5],
    ])
  })

  it('la tabla fijada rellena cada celda al llegar su valor', () => {
    const t = ok(find('dos-tablas-producto'))
    const landed = t.steps.find((s) => {
      if (s.kind !== 'scalar-result') return false
      const row = s.tables.find((x) => x.id.startsWith('VALUES@'))?.rows.find((r) => r.status === 'active')
      return !!row?.note?.includes('Devuelto = 3')
    })!
    const row = landed.tables.find((x) => x.id.startsWith('VALUES@'))!.rows.find((r) => r.status === 'active')!
    expect(row.cells.slice(0, 3)).toEqual(['Aceite', 12, 3])
    expect(row.note).toBe('Vendido = 12, Devuelto = 3')
  })
})

describe('funciones que combinan tablas', () => {
  const v = 'VALUES(Ventas[Producto])'
  const d = 'VALUES(Devoluciones[Producto])'

  it('EXCEPT e INTERSECT', () => {
    expect(table(`EXCEPT(${v}, ${d})`)).toEqual([['Queso']])
    expect(table(`INTERSECT(${v}, ${d})`).map((r) => r[0])).toEqual(['Aceite', 'Arroz', 'Leche', 'Jabon'])
  })

  it('EXCEPT muestra una nota por fila y marca la coincidencia en la segunda tabla', () => {
    const t = ok(`EXCEPT(${v}, ${d})`)
    const rows = t.steps.filter((s) => s.kind === 'iterate-row')
    expect(rows).toHaveLength(5)
    expect(rows.every((s) => s.detail === 'minor')).toBe(true)
    const notes = rows[4].tables.flatMap((x) => x.rows.map((r) => r.note).filter(Boolean))
    expect(notes).toContain('"Queso" no está en la segunda tabla -> se conserva')
    expect(notes).toContain('"Aceite" está en la segunda tabla -> se descarta')
    const first = rows[0].tables
    expect(first).toHaveLength(2)
    expect(first[1].rows.filter((r) => r.status === 'active')).toHaveLength(1)
    expect(rows[3].tables[1].rows.some((r) => r.status === 'active')).toBe(false)
  })

  it('UNION conserva duplicados y anota el origen', () => {
    expect(table(`UNION(${v}, ${d})`)).toHaveLength(9)
    const t = ok(`UNION(${v}, ${d})`)
    const res = t.steps.find((s) => s.title.startsWith('UNION devuelve'))!
    const out = res.tables[res.tables.length - 1]
    expect(out.rows[0].note).toContain('Tabla 1')
    expect(out.rows[8].note).toContain('Tabla 2')
    expect(new Set(out.rows.map((r) => r.key)).size).toBe(9)
    expect(t.steps.filter((s) => s.kind === 'enter')[0].explanation).toContain('mismo número de columnas')
  })

  it('UNION con distinto numero de columnas da error', () => {
    const e = fail(`UNION(${v}, Productos)`)
    expect(e.message).toContain('mismo número de columnas')
    expect(e.span).not.toBeNull()
  })

  it('CROSSJOIN', () => {
    const rows = table('CROSSJOIN(VALUES(Productos[Proveedor]), VALUES(Calendario[NombreMes]))')
    expect(rows).toHaveLength(9)
    expect(rows[0]).toEqual(['Andina', 'Enero'])
    const t = ok('CROSSJOIN(VALUES(Productos[Proveedor]), VALUES(Calendario[NombreMes]))')
    expect(t.steps.some((s) => s.explanation.includes('3 x 3 = 9 filas'))).toBe(true)
    expect(t.steps.some((s) => s.kind === 'iterate-row')).toBe(false)
    expect(fail(`CROSSJOIN(${v}, VALUES(Productos[Producto]))`).message).toContain('mismo nombre')
  })

  it('TREATAS mueve el filtro de una tabla de hechos a otra', () => {
    const base = 'CALCULATE(SUM(Devoluciones[Cantidad]), TREATAS(VALUES(Ventas[Producto]), Devoluciones[Producto]))'
    expect(scalar(base)).toBe(7)
    expect(scalar(`CALCULATE(${base}, Ventas[Ciudad] = "Cali")`)).toBe(6)
    expect(scalar('CALCULATE(CALCULATE(SUM(Devoluciones[Cantidad])), Ventas[Ciudad] = "Cali")')).toBe(7)
    expect(scalar(find('treatas-devoluciones').replace(/\n\s*/g, ' '))).toBe(6)
  })

  it('TREATAS explica el cambio de encabezado', () => {
    const t = ok('CALCULATE(SUM(Devoluciones[Cantidad]), TREATAS(VALUES(Ventas[Producto]), Devoluciones[Producto]))')
    const step = t.steps.find((s) => s.title === 'Entra TREATAS')!
    expect(step.tables).toHaveLength(2)
    expect(step.tables[1].columns[0].name).toBe('Producto')
    expect(step.explanation).toContain('Devoluciones[Producto]')
    expect(t.steps.some((s) => s.kind === 'context-change')).toBe(true)
  })

  it('TREATAS con distinto numero de columnas da error', () => {
    expect(fail('TREATAS(VALUES(Ventas[Producto]), Devoluciones[Producto], Devoluciones[Motivo])').message).toContain('TREATAS')
  })
})

describe('ejemplos de dos tablas', () => {
  const cases: [string, Value | Value[][]][] = [
    ['dos-tablas-neto', 31],
    ['dos-tablas-proveedor', 16],
    ['except-nunca-devueltos', [['Queso']]],
    ['treatas-devoluciones', 6],
  ]
  for (const [id, expected] of cases) {
    it(`${id} da el valor esperado`, () => {
      const f = find(id)
      const t = ok(f)
      if (t.result.kind === 'scalar') expect(t.result.value).toBe(expected)
      else expect(t.result.table.rows.map((r) => r.cells)).toEqual(expected)
    })
  }

  it('todos los ejemplos tienen start, result, spans validos y 5 relaciones', () => {
    for (const ex of examples) {
      const t = ok(ex.formula)
      expect(t.steps[0].kind).toBe('start')
      expect(t.steps[t.steps.length - 1].kind).toBe('result')
      for (const s of t.steps) {
        if (s.span) expect(s.span.end).toBeLessThanOrEqual(ex.formula.length)
        expect(s.relationships).toHaveLength(5)
        expect(s.tables.length).toBeLessThanOrEqual(3)
      }
    }
  })
})
