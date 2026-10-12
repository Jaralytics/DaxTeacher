import { describe, it, expect } from 'vitest'
import { probe } from './index'
import type { ProbeResult, ProbeSuccess } from './index'
import { sampleModel } from '../data/sampleModel'

function ok(r: ProbeResult): ProbeSuccess {
  if (!r.ok) throw new Error(r.error.message)
  return r
}

describe('probe', () => {
  it('sin opciones evalua sobre todo el modelo', () => {
    const r = ok(probe('SUM(Ventas[Cantidad])', sampleModel))
    expect(r.value).toBe(38)
    expect(r.visibleRows.Ventas).toHaveLength(10)
    expect(r.scannedRows.Ventas).toHaveLength(10)
    expect(r.contextTransition).toBe(false)
    expect(r.innerFilterContext).toEqual([])
  })

  it('un filtro del calendario restringe Ventas pero no Productos', () => {
    const r = ok(probe('SUM(Ventas[Cantidad])', sampleModel, { filters: [{ column: 'calendario[nombremes]', values: ['Febrero'] }] }))
    expect(r.value).toBe(15)
    expect(r.visibleRows.Ventas).toHaveLength(4)
    expect(r.visibleRows.Productos).toHaveLength(5)
    expect(r.innerFilterContext).toHaveLength(1)
    expect(r.innerFilterContext[0].origin).toBe('existing')
  })

  it('un filtro de Productos restringe las dos tablas de hechos', () => {
    const r = ok(probe('SUM(Ventas[Cantidad])', sampleModel, { filters: [{ column: 'Productos[Proveedor]', values: ['Andina'] }] }))
    expect(r.visibleRows.Ventas).toHaveLength(5)
    expect(r.visibleRows.Devoluciones).toHaveLength(3)
    expect(r.value).toBe(20)
  })

  it('sin valores permitidos no se ve ninguna fila', () => {
    const r = ok(probe('SUM(Ventas[Cantidad])', sampleModel, { filters: [{ column: 'Ventas[Producto]', values: [] }] }))
    expect(r.visibleRows.Ventas).toEqual([])
    expect(r.value).toBeNull()
  })

  it('contexto de fila: aritmetica por fila sin lecturas', () => {
    const r = ok(probe('Ventas[Cantidad] * Ventas[Precio]', sampleModel, { row: { table: 'Ventas', rowIndex: 0 } }))
    expect(r.value).toBe(60)
    expect(r.scannedRows).toEqual({})
  })

  it('un agregador ignora el contexto de fila; CALCULATE hace transicion', () => {
    const row = { table: 'Ventas', rowIndex: 0 }
    const a = ok(probe('SUM(Ventas[Cantidad])', sampleModel, { row }))
    expect(a.value).toBe(38)
    expect(a.scannedRows.Ventas).toHaveLength(10)
    expect(a.contextTransition).toBe(false)
    const b = ok(probe('CALCULATE(SUM(Ventas[Cantidad]))', sampleModel, { row }))
    expect(b.value).toBe(5)
    expect(b.scannedRows.Ventas).toEqual([0])
    expect(b.contextTransition).toBe(true)
    expect(b.innerFilterContext.length).toBeGreaterThan(0)
    expect(b.visibleRows.Ventas).toHaveLength(10)
  })

  it('RELATED funciona y no cuenta como lectura', () => {
    const r = ok(probe('RELATED(Productos[Marca])', sampleModel, { row: { table: 'Ventas', rowIndex: 0 } }))
    expect(r.value).toBe('Oliva Real')
    expect(r.scannedRows).toEqual({})
  })

  it('una formula de tabla devuelve value null', () => {
    const r = ok(probe('FILTER(Ventas, Ventas[Cantidad] = 5)', sampleModel))
    expect(r.value).toBeNull()
    expect(r.scannedRows.Ventas).toHaveLength(10)
  })

  it('errores sin lanzar', () => {
    const e = probe('Ventas[Cantidad]', sampleModel)
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.error.message).toContain('contexto de fila')
    expect(probe('1', sampleModel, { filters: [{ column: 'Ventas[Nada]', values: [1] }] }).ok).toBe(false)
    expect(probe('1', sampleModel, { row: { table: 'Nada', rowIndex: 0 } }).ok).toBe(false)
    expect(probe('1', sampleModel, { row: { table: 'Ventas', rowIndex: 99 } }).ok).toBe(false)
    expect(probe('FOO(', sampleModel).ok).toBe(false)
  })
})
