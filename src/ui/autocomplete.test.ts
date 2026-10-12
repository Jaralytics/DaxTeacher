import { describe, expect, it } from 'vitest'
import { functionCatalog } from '../data/functions'
import { sampleModel } from '../data/sampleModel'
import { SUPPORTED_FUNCTIONS } from '../engine/parser'
import { run } from '../engine'
import {
  applySuggestion,
  getCompletionContext,
  getSignatureContext,
  getSuggestions,
  signatureParts,
} from './autocomplete'

const tables = sampleModel.tables

function suggest(text: string, caret = text.length, explicit = false) {
  const ctx = getCompletionContext(text, caret, explicit)
  return ctx ? { ctx, list: getSuggestions(ctx, functionCatalog, tables) } : null
}

describe('catalogo de funciones', () => {
  it('coincide con las funciones que soporta el motor', () => {
    expect(functionCatalog.map((f) => f.name).sort()).toEqual([...SUPPORTED_FUNCTIONS].sort())
  })

  it('todos los ejemplos se ejecutan sin error', () => {
    for (const f of functionCatalog) {
      const r = run(f.example, sampleModel)
      expect(r.ok, `${f.name}: ${f.example} -> ${r.ok ? '' : r.error.message}`).toBe(true)
    }
  })

  it('cada snippet termina en parentesis de apertura', () => {
    for (const f of functionCatalog) expect(f.snippet).toBe(`${f.name}(`)
  })
})

describe('autocompletado', () => {
  it('sugiere funciones al escribir un prefijo', () => {
    const r = suggest('CALC')
    expect(r?.ctx.mode).toBe('word')
    expect(r?.list.map((s) => s.label)).toEqual(['CALCULATE', 'CALCULATETABLE'])
    expect(r?.list[0].insert).toBe('CALCULATE(')
  })

  it('ordena prefijos antes que subcadenas, sin distinguir mayusculas', () => {
    const labels = suggest('sum')?.list.map((s) => s.label) ?? []
    expect(labels.slice(0, 2)).toEqual(['SUM', 'SUMX'])
    const sub = suggest('ount')?.list.map((s) => s.label) ?? []
    expect(sub).toContain('COUNTROWS')
  })

  it('sugiere tablas y columnas calificadas en modo palabra', () => {
    const labels = suggest('Ven')?.list.map((s) => s.label) ?? []
    expect(labels[0]).toBe('Ventas')
    const cols = suggest('Prec')?.list.map((s) => s.label) ?? []
    expect(cols).toContain('Ventas[Precio]')
  })

  it('tras Tabla[ solo sugiere columnas de esa tabla', () => {
    const r = suggest('SUM(Ventas[Pr')
    expect(r?.ctx.mode).toBe('column')
    expect(r?.ctx.table).toBe('Ventas')
    expect(r?.list.map((s) => s.label)).toEqual(['Precio', 'Producto'])
    expect(r?.list[0].insert).toBe('Precio]')
  })

  it('sugiere columnas de otras tablas y la tabla Calendario', () => {
    expect(suggest('Calendario[')?.list.map((s) => s.label)).toEqual(['Fecha', 'Mes', 'NombreMes'])
    expect(suggest('RELATED(Productos[Ma')?.list.map((s) => s.label)).toEqual(['Marca'])
    expect(suggest('Calen')?.list[0].label).toBe('Calendario')
  })

  it('con una tabla desconocida no sugiere nada', () => {
    expect(suggest('Otra[')?.list).toEqual([])
  })

  it('con un corchete suelto sugiere columnas de todas las tablas', () => {
    const r = suggest('SUM([')
    expect(r?.ctx.table).toBeNull()
    expect(r?.list).toHaveLength(tables.reduce((n, t) => n + t.columns.length, 0))
  })

  it('no sugiere dentro de cadenas ni comentarios', () => {
    expect(suggest('FILTER(Ventas, Ventas[Producto] = "Ace')).toBeNull()
    expect(suggest('// SUM')).toBeNull()
    expect(suggest('/* SUM')).toBeNull()
    expect(suggest('SUM(Ventas[Cantidad]) // otra SU')).toBeNull()
    expect(suggest('"cadena" & SU')?.list[0].label).toBe('SUM')
  })

  it('no sugiere sin texto salvo Ctrl+Espacio', () => {
    expect(suggest('SUM(')).toBeNull()
    expect(suggest('SUM(', 4, true)?.list.length).toBeGreaterThan(10)
  })

  it('acepta una funcion reemplazando la palabra', () => {
    const r = suggest('CAL')!
    const out = applySuggestion('CAL', r.ctx, r.list[0])
    expect(out).toEqual({ value: 'CALCULATE(', caret: 10 })
  })

  it('acepta una columna y cierra el corchete una sola vez', () => {
    const text = 'SUM(Ventas[Pr)'
    const caret = 13
    const r = suggest(text, caret)!
    const out = applySuggestion(text, r.ctx, r.list[0])
    expect(out.value).toBe('SUM(Ventas[Precio])')
    const closed = 'SUM(Ventas[Pr])'
    const r2 = suggest(closed, 13)!
    const out2 = applySuggestion(closed, r2.ctx, r2.list[0])
    expect(out2.value).toBe('SUM(Ventas[Precio])')
    expect(out2.caret).toBe(18)
  })

  it('pone comillas simples a tablas con espacios', () => {
    const r = suggest('Mi', 2)
    const model = [{ name: 'Mis ventas', columns: [] }]
    const ctx = getCompletionContext('Mi', 2)!
    const list = getSuggestions(ctx, [], model)
    expect(list[0].insert).toBe("'Mis ventas'")
    expect(r).not.toBeNull()
  })
})

describe('ayuda de firma', () => {
  const sig = (text: string) => getSignatureContext(text, text.length, functionCatalog)

  it('detecta la funcion y el argumento actual', () => {
    expect(sig('FILTER(')).toMatchObject({ argIndex: 0 })
    expect(sig('FILTER(Ventas, ')).toMatchObject({ argIndex: 1 })
    expect(sig('FILTER(Ventas, ')?.doc.name).toBe('FILTER')
  })

  it('usa la llamada interna en llamadas anidadas', () => {
    const r = sig('CALCULATE(SUMX(Ventas, Ventas[Cantidad] * ')
    expect(r?.doc.name).toBe('SUMX')
    expect(r?.argIndex).toBe(1)
  })

  it('vuelve a la llamada externa tras cerrar la interna', () => {
    const r = sig('CALCULATE(SUM(Ventas[Cantidad]), ')
    expect(r?.doc.name).toBe('CALCULATE')
    expect(r?.argIndex).toBe(1)
  })

  it('ignora comas dentro de cadenas, corchetes y llaves', () => {
    expect(sig('DIVIDE(Ventas[a,b], "x,y", ')?.argIndex).toBe(2)
    expect(sig('FILTER(Ventas, Ventas[Producto] IN {"a", "b"')?.argIndex).toBe(1)
  })

  it('un parentesis de agrupacion no oculta la funcion', () => {
    const r = sig('SUMX(Ventas, (Ventas[Cantidad] + ')
    expect(r?.doc.name).toBe('SUMX')
    expect(r?.argIndex).toBe(1)
  })

  it('no hay ayuda fuera de llamadas o dentro de cadenas', () => {
    expect(sig('Ventas')).toBeNull()
    expect(sig('FILTER(Ventas, "abc')).toBeNull()
  })

  it('separa la sintaxis y resalta el parametro', () => {
    const doc = functionCatalog.find((f) => f.name === 'CALCULATE')!
    expect(signatureParts(doc, 0)).toMatchObject({ parts: ['<expresión>', '<filtro>', '...'], active: 0 })
    expect(signatureParts(doc, 5).active).toBe(1)
    const filter = functionCatalog.find((f) => f.name === 'FILTER')!
    expect(signatureParts(filter, 3).active).toBe(-1)
  })
})
