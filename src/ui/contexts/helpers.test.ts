import { describe, expect, it } from 'vitest'
import { sampleModel } from '../../data/sampleModel'
import {
  cellFilters,
  cellSentence,
  columnFormula,
  distinctValues,
  filterPredicate,
  parseColumn,
  playerFormula,
  relatedRowIndex,
  relationBetween,
  substituteRow,
  tablesRead,
} from './helpers'

const base = {
  rowField: 'Productos[Proveedor]',
  colField: 'Calendario[NombreMes]',
  slicerField: 'Ventas[Ciudad]',
  slicerValues: [],
}

describe('ayudas de contextos', () => {
  it('parsea columnas calificadas', () => {
    expect(parseColumn('Productos[Proveedor]')).toEqual({ table: 'Productos', column: 'Proveedor' })
  })

  it('da los valores distintos en el orden del modelo', () => {
    expect(distinctValues(sampleModel, 'Calendario[NombreMes]')).toEqual(['Enero', 'Febrero', 'Marzo'])
    expect(distinctValues(sampleModel, 'Productos[Proveedor]')).toEqual(['Andina', 'Lacteos del Valle', 'Quimicos Norte'])
    expect(distinctValues(sampleModel, 'Nada[X]')).toEqual([])
  })

  it('construye los filtros de una celda y omite los de los totales', () => {
    expect(cellFilters({ ...base, rowValue: 'Andina', colValue: 'Febrero' })).toEqual([
      { column: 'Productos[Proveedor]', values: ['Andina'] },
      { column: 'Calendario[NombreMes]', values: ['Febrero'] },
    ])
    expect(cellFilters({ ...base, rowValue: 'Andina' })).toHaveLength(1)
    expect(cellFilters({ ...base })).toEqual([])
  })

  it('agrega la segmentacion salvo que coincida con filas o columnas', () => {
    const withSlicer = { ...base, slicerValues: ['Bogota', 'Cali'] }
    expect(cellFilters(withSlicer)).toEqual([{ column: 'Ventas[Ciudad]', values: ['Bogota', 'Cali'] }])
    expect(cellFilters({ ...withSlicer, rowField: 'Ventas[Ciudad]', rowValue: 'Cali' })).toEqual([
      { column: 'Ventas[Ciudad]', values: ['Cali'] },
    ])
  })

  it('escribe predicados DAX', () => {
    expect(filterPredicate({ column: 'Productos[Proveedor]', values: ['Andina'] })).toBe('Productos[Proveedor] = "Andina"')
    expect(filterPredicate({ column: 'Ventas[Ciudad]', values: ['Bogota', 'Cali'] })).toBe(
      'Ventas[Ciudad] IN {"Bogota", "Cali"}',
    )
    expect(filterPredicate({ column: 'Ventas[Cantidad]', values: [5] })).toBe('Ventas[Cantidad] = 5')
  })

  it('arma la formula del reproductor', () => {
    const filters = cellFilters({ ...base, rowValue: 'Andina', colValue: 'Febrero' })
    expect(playerFormula('SUM(Ventas[Cantidad])', filters)).toBe(
      'CALCULATE(SUM(Ventas[Cantidad]), Productos[Proveedor] = "Andina", Calendario[NombreMes] = "Febrero")',
    )
    expect(playerFormula('SUM(Ventas[Cantidad])', [])).toBe('SUM(Ventas[Cantidad])')
    expect(columnFormula('Ventas', 'Resultado', 'Ventas[Cantidad] * Ventas[Precio]')).toBe(
      'ADDCOLUMNS(Ventas, "Resultado", Ventas[Cantidad] * Ventas[Precio])',
    )
  })

  it('lee una celda en palabras', () => {
    expect(cellSentence('La cantidad vendida', [])).toContain('sin ningún filtro')
    const s = cellSentence('La cantidad vendida', cellFilters({ ...base, rowValue: 'Andina', colValue: 'Febrero' }))
    expect(s).toBe('La cantidad vendida solo de las filas donde Proveedor es Andina y NombreMes es Febrero.')
  })

  it('sustituye los valores de la fila actual en expresiones simples', () => {
    expect(substituteRow('Ventas[Cantidad] * Ventas[Precio]', sampleModel, 'Ventas', 0)).toBe('5 * 12')
    expect(substituteRow('SUM(Ventas[Cantidad])', sampleModel, 'Ventas', 0)).toBeNull()
  })

  it('encuentra la fila relacionada del lado uno', () => {
    // La venta 1 es de Aceite, primera fila de Productos.
    expect(relatedRowIndex(sampleModel, 'Ventas', 0, 'Productos')).toBe(0)
    expect(relatedRowIndex(sampleModel, 'Ventas', 4, 'Productos')).toBe(3)
    expect(relatedRowIndex(sampleModel, 'Ventas', 0, 'Nada')).toBeNull()
  })

  it('localiza la relacion entre dimension y hechos', () => {
    expect(relationBetween(sampleModel, 'Productos', 'Ventas')?.fromColumn).toBe('Producto')
    expect(relationBetween(sampleModel, 'Calendario', 'Ventas')?.fromColumn).toBe('FechaVenta')
  })

  it('detecta las tablas que lee una medida', () => {
    expect(tablesRead('SUM(Ventas[Cantidad]) - SUM(Devoluciones[Cantidad])', sampleModel)).toEqual(['Ventas', 'Devoluciones'])
    expect(tablesRead('COUNTROWS(Ventas)', sampleModel)).toEqual(['Ventas'])
  })
})
