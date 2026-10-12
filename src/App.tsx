import { useEffect, useRef, useState } from 'react'
import './App.css'
import { examples } from './data/examples'
import { functionCatalog } from './data/functions'
import { sampleModel } from './data/sampleModel'
import type { DaxError, Example, SourceSpan, Trace } from './engine'
import { ExamplePicker } from './ui/ExamplePicker'
import { ExplanationPanel } from './ui/ExplanationPanel'
import { FormulaEditor } from './ui/FormulaEditor'
import type { EditorHandle } from './ui/FormulaEditor'
import { PlayerBar } from './ui/PlayerBar'
import { Sidebar } from './ui/Sidebar'
import { Stage } from './ui/Stage'
import { ContextsView } from './ui/contexts/ContextsView'
import { Segmented } from './ui/contexts/Segmented'
import { runFormula } from './ui/runFormula'
import { usePlayer } from './ui/usePlayer'

type Outcome = { kind: 'idle' } | { kind: 'trace'; trace: Trace } | { kind: 'error'; error: DaxError }

function execute(formula: string): Outcome {
  const result = runFormula(formula)
  return result.ok ? { kind: 'trace', trace: result.trace } : { kind: 'error', error: result.error }
}

type View = 'reproductor' | 'contextos'

const VIEWS = [
  { id: 'reproductor' as const, label: 'Reproductor' },
  { id: 'contextos' as const, label: 'Contextos' },
]

function readView(): View {
  return window.location.hash === '#contextos' ? 'contextos' : 'reproductor'
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true
  return target instanceof HTMLInputElement && target.type !== 'checkbox'
}

export default function App() {
  const [initial] = useState(() => examples[0] ?? null)
  const [formula, setFormula] = useState(initial?.formula ?? '')
  const [exampleId, setExampleId] = useState<string | null>(initial?.id ?? null)
  const [outcome, setOutcome] = useState<Outcome>(() => (initial ? execute(initial.formula) : { kind: 'idle' }))

  const [view, setViewState] = useState<View>(readView)
  const [hoverSpan, setHoverSpan] = useState<SourceSpan | null>(null)
  const editorRef = useRef<EditorHandle>(null)

  const trace = outcome.kind === 'trace' ? outcome.trace : null
  const player = usePlayer(trace?.steps ?? null)
  const step = trace ? (trace.steps[player.index] ?? null) : null

  function setView(next: View) {
    setViewState(next)
    if (readView() !== next) window.location.hash = next === 'contextos' ? '#contextos' : '#reproductor'
  }

  useEffect(() => {
    const onHash = () => setViewState(readView())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  function openInPlayer(text: string) {
    loadFormula(text, null)
    setView('reproductor')
  }

  function run() {
    if (formula.trim()) setOutcome(execute(formula))
  }

  function edit(value: string) {
    setFormula(value)
    setExampleId(null)
    setOutcome({ kind: 'idle' })
  }

  function loadFormula(text: string, id: string | null) {
    setFormula(text)
    setExampleId(id)
    setOutcome(execute(text))
  }

  function loadExample(example: Example) {
    loadFormula(example.formula, example.id)
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (view !== 'reproductor') return
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return
      const onControl = e.target instanceof HTMLButtonElement || e.target instanceof HTMLInputElement
      if (e.code === 'Space') {
        if (onControl) return
        e.preventDefault()
        player.toggle()
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        player.next()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        player.prev()
      } else if (e.key === 'Home') {
        e.preventDefault()
        player.restart()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const selected = examples.find((e) => e.id === exampleId)
  const error = outcome.kind === 'error' ? outcome.error : null

  return (
    <div className="app">
      <header className="top">
        <h1>DaxTeacher</h1>
        <p>Mira paso a paso qué hace una expresión DAX por dentro.</p>
        <Segmented items={VIEWS} value={view} onChange={setView} label="Vistas" idPrefix="view" className="view-tabs" />
      </header>

      {view === 'contextos' ? (
        <main className="contexts-main" id="view-panel">
          <ContextsView onOpenInPlayer={openInPlayer} />
        </main>
      ) : (
      <main className="layout" id="view-panel">
        <Sidebar
          tables={sampleModel.tables}
          relationships={sampleModel.relationships}
          catalog={functionCatalog}
          onInsert={(text) => editorRef.current?.insert(text)}
          onExample={(text) => loadFormula(text, null)}
        />

        <div className="workspace">
          <section className="formula-area" aria-label="Fórmula">
            <div className="formula-bar">
              <ExamplePicker examples={examples} selectedId={exampleId} onSelect={loadExample} />
              <button type="button" className="run-btn" onClick={run} disabled={!formula.trim()}>
                Ejecutar
                <kbd>Ctrl+Enter</kbd>
              </button>
            </div>
            <FormulaEditor
              ref={editorRef}
              catalog={functionCatalog}
              tables={sampleModel.tables}
              value={formula}
              onChange={edit}
              onRun={run}
              highlight={step ? step.span : null}
              hoverSpan={hoverSpan}
              errorSpan={error ? error.span : null}
            />
            {selected && <p className="example-note">{selected.description}</p>}
            {error && (
              <p className="error-msg" role="alert">
                {error.message}
              </p>
            )}
          </section>

          <Stage step={step} onHoverSpan={setHoverSpan} />
        </div>

        <aside className="panel" aria-label="Explicación">
          <ExplanationPanel step={step} index={player.index} count={player.count} />
        </aside>
      </main>
      )}

      {view === 'reproductor' && <PlayerBar player={player} steps={trace?.steps ?? null} />}
    </div>
  )
}
