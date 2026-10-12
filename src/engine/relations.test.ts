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

describe('propagacion de filtros', () => {
  it('un filtro del lado uno llega al lado muchos', () => {
    expect(scalar('CALCULATE(SUM(Ventas[Cantidad]), Productos[Proveedor] = "Andina")')).toBe(20)
    const rows = table('CALCULATETABLE(Ventas, Calendario[NombreMes] = "Febrero")')
    expect(rows.map((r) => r[0])).toEqual([5, 6, 7, 8])
  })

  it('emite apply-filters del lado uno y un paso propagate con ambas tablas', () => {
    const t = ok('CALCULATE(SUM(Ventas[Cantidad]), Productos[Proveedor] = "Andina")')
    const kinds = t.steps.map((s) => s.kind)
    const ap = kinds.indexOf('apply-filters')
    const pr = kinds.indexOf('propagate')
    expect(ap).toBeGreaterThan(-1)
    expect(pr).toBeGreaterThan(ap)
    const step = t.steps[pr]
    const prod = step.tables.find((x) => x.id === 'Productos')!
    const ven = step.tables.find((x) => x.id === 'Ventas')!
    expect(prod.columns.find((c) => c.name === 'Producto')!.highlight).toBe(true)
    expect(ven.columns.find((c) => c.name === 'Producto')!.highlight).toBe(true)
    expect(ven.rows.filter((r) => r.status === 'kept')).toHaveLength(5)
    expect(step.relationships.filter((r) => r.used)).toHaveLength(1)
    expect(step.explanation).toContain('Aceite')
  })

  it('un filtro del lado muchos no llega al lado uno', () => {
    expect(scalar('CALCULATE(COUNTROWS(Productos), Ventas[Ciudad] = "Cali")')).toBe(5)
    const t = ok('CALCULATETABLE(VALUES(Productos[Marca]), Ventas[Ciudad] = "Cali")')
    expect(t.steps.some((s) => s.kind === 'propagate')).toBe(false)
    if (t.result.kind === 'table') expect(t.result.table.rows).toHaveLength(4)
  })
})

describe('RELATED y RELATEDTABLE', () => {
  it('RELATED devuelve el valor del lado uno y explica la busqueda una sola vez', () => {
    const t = ok('ADDCOLUMNS(Ventas, "Marca", RELATED(Productos[Marca]))')
    if (t.result.kind !== 'table') throw new Error('tabla')
    expect(t.result.table.rows[0].cells[8]).toBe('Oliva Real')
    expect(t.result.table.columns[8].type).toBe('string')
    expect(t.steps.filter((s) => s.title.startsWith('RELATED busca'))).toHaveLength(1)
    const row = t.steps.find((s) => s.kind === 'iterate-row')!.tables.find((x) => x.id === 'Ventas')!.rows[0]
    expect(row.note).toBe('RELATED(Productos[Marca]) = "Oliva Real"')
  })

  it('RELATED dentro de FILTER', () => {
    const rows = table('FILTER(Ventas, RELATED(Productos[Proveedor]) = "Quimicos Norte")')
    expect(rows.map((r) => r[0])).toEqual([7, 10])
  })

  it('RELATED sin contexto de fila o sin relacion da error didactico', () => {
    expect(fail('RELATED(Productos[Marca])').message).toContain('contexto de fila')
    const e = fail('ADDCOLUMNS(Productos, "x", RELATED(Ventas[Cantidad]))')
    expect(e.message).toContain('No hay una relación')
  })

  it('RELATEDTABLE cuenta las ventas de cada producto', () => {
    const rows = table('ADDCOLUMNS(Productos, "Ventas", COUNTROWS(RELATEDTABLE(Ventas)))')
    expect(rows.map((r) => [r[0], r[3]])).toEqual([
      ['Aceite', 3],
      ['Arroz', 2],
      ['Leche', 2],
      ['Queso', 1],
      ['Jabon', 2],
    ])
    const t = ok('ADDCOLUMNS(Productos, "Ventas", COUNTROWS(RELATEDTABLE(Ventas)))')
    expect(t.steps.some((s) => s.kind === 'context-transition')).toBe(true)
    expect(t.steps.some((s) => s.explanation.includes('CALCULATETABLE(Ventas) disfrazado'))).toBe(true)
  })

  it('RELATEDTABLE sin contexto de fila da error', () => {
    expect(fail('COUNTROWS(RELATEDTABLE(Ventas))').message).toContain('contexto de fila')
  })
})

describe('USERELATIONSHIP', () => {
  const byDelivery =
    'CALCULATE(SUM(Ventas[Cantidad]), Calendario[NombreMes] = "Febrero", USERELATIONSHIP(Ventas[FechaEntrega], Calendario[Fecha]))'

  it('cambia el resultado respecto a la relacion por defecto', () => {
    expect(scalar('CALCULATE(SUM(Ventas[Cantidad]), Calendario[NombreMes] = "Febrero")')).toBe(15)
    expect(scalar(byDelivery)).toBe(11)
  })

  it('por mes con la relacion de entrega', () => {
    const rows = table(
      'ADDCOLUMNS(VALUES(Calendario[NombreMes]), "Entregado", CALCULATE(SUM(Ventas[Cantidad]), USERELATIONSHIP(Ventas[FechaEntrega], Calendario[Fecha])))',
    )
    expect(rows).toEqual([
      ['Enero', 10],
      ['Febrero', 11],
      ['Marzo', 17],
    ])
  })

  it('tiene un paso relationship-change y restaura al terminar', () => {
    const t = ok(byDelivery)
    const step = t.steps.find((s) => s.kind === 'relationship-change')!
    expect(step.detail).toBe('major')
    expect(step.relationships.map((r) => r.status)).toEqual(['active', 'deactivated', 'activated', 'active', 'active'])
    expect(step.relationships[2].used).toBe(true)
    expect(step.explanation).toContain('Ventas[FechaEntrega]')
    const idx = t.steps.indexOf(step)
    expect(t.steps[idx + 1].relationships.map((r) => r.status)).toEqual(['active', 'inactive', 'active', 'active', 'active'])
    const done = t.steps.find((s) => s.kind === 'scalar-result')!
    expect(done.relationships.map((r) => r.status)).toEqual(['active', 'active', 'inactive', 'active', 'active'])
    expect(done.explanation).toContain('vuelven a su estado original')
    const last = t.steps[t.steps.length - 1]
    expect(last.relationships.map((r) => r.status)).toEqual(['active', 'active', 'inactive', 'active', 'active'])
  })

  it('acepta las columnas en cualquier orden', () => {
    expect(
      scalar('CALCULATE(SUM(Ventas[Cantidad]), Calendario[NombreMes] = "Febrero", USERELATIONSHIP(Calendario[Fecha], Ventas[FechaEntrega]))'),
    ).toBe(11)
  })

  it('da error si no existe la relacion o se usa fuera de CALCULATE', () => {
    expect(fail('CALCULATE(SUM(Ventas[Cantidad]), USERELATIONSHIP(Ventas[Ciudad], Calendario[Fecha]))').message).toContain('no existe una relación')
    expect(fail('USERELATIONSHIP(Ventas[FechaEntrega], Calendario[Fecha])').message).toContain('solo se puede usar')
  })
})

describe('fechas', () => {
  it('DATE y comparaciones cronologicas', () => {
    expect(scalar('DATE(2026, 2, 1)')).toBe('2026-02-01')
    expect(scalar('COUNTROWS(FILTER(Calendario, Calendario[Fecha] >= DATE(2026, 2, 1)))')).toBe(4)
    expect(scalar('CALCULATE(SUM(Ventas[Cantidad]), Calendario[Fecha] >= DATE(2026, 3, 1))')).toBe(8)
  })

  it('las notas muestran fechas como dd/mm/aaaa', () => {
    const t = ok('FILTER(Calendario, Calendario[Fecha] >= DATE(2026, 2, 1))')
    const note = t.steps.find((s) => s.kind === 'iterate-row')!.tables.find((x) => x.id === 'Calendario')!.rows[0].note
    expect(note).toBe('10/01/2026 >= 01/02/2026 -> FALSO')
  })

  it('MIN y MAX funcionan, SUM da error y DATE valida', () => {
    expect(scalar('MIN(Ventas[FechaVenta])')).toBe('2026-01-10')
    expect(scalar('MAX(Ventas[FechaEntrega])')).toBe('2026-03-12')
    expect(fail('SUM(Ventas[FechaVenta])').message).toContain('fechas')
    expect(fail('DATE(2026, 2, 30)').message).toContain('DATE')
  })

  it('las columnas de fecha llevan type date', () => {
    const t = ok('ALL(Calendario)')
    if (t.result.kind !== 'table') throw new Error('tabla')
    expect(t.result.table.columns.map((c) => c.type)).toEqual(['date', 'number', 'string'])
  })
})

describe('relaciones en la traza', () => {
  for (const ex of examples) {
    it(`${ex.id}: cada paso trae las 5 relaciones`, () => {
      const t = ok(ex.formula)
      const valid = ['active', 'inactive', 'activated', 'deactivated']
      for (const s of t.steps) {
        expect(s.relationships).toHaveLength(5)
        for (const r of s.relationships) expect(valid).toContain(r.status)
      }
    })
  }
})
