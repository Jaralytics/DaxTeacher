import type { TraceStep } from '../engine'
import { FilterContext, RelationshipsContext, RowContext } from './ContextPanels'
import { formatPlain, renderInlineCode } from './format'

interface Props {
  step: TraceStep | null
  index: number
  count: number
}

export function ExplanationPanel({ step, index, count }: Props) {
  return (
    <div className="panel-inner">
      <p className="sr-only" aria-live="polite">
        {step ? step.title : ''}
      </p>
      {step ? (
        <>
          <p className="step-counter">
            Paso {index + 1} de {count}
          </p>
          <h2 className="step-title">{step.title}</h2>
          <p className="step-text">{renderInlineCode(step.explanation)}</p>
          {step.scalar && (
            <div className="scalar">
              <span className="scalar-label">{step.scalar.label}</span>
              <span className="scalar-value">{formatPlain(step.scalar.value)}</span>
            </div>
          )}
        </>
      ) : (
        <>
          <h2 className="step-title">Sin ejecución</h2>
          <p className="step-text">
            Escribe una expresión o elige un ejemplo y pulsa <code>Ejecutar</code>. Aquí verás la explicación de cada
            paso.
          </p>
        </>
      )}
      <FilterContext entries={step?.filterContext ?? []} />
      <RowContext entries={step?.rowContext ?? []} />
      <RelationshipsContext entries={step?.relationships} />
    </div>
  )
}
