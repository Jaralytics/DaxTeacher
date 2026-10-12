import { useState } from 'react'
import './contexts.css'
import { FilterContextLesson } from './FilterContextLesson'
import { RowContextLesson } from './RowContextLesson'
import { Segmented } from './Segmented'
import { TransitionLesson } from './TransitionLesson'

type Lesson = 'filtro' | 'fila' | 'transicion'

const LESSONS = [
  { id: 'filtro' as const, label: 'Contexto de filtro' },
  { id: 'fila' as const, label: 'Contexto de fila' },
  { id: 'transicion' as const, label: 'Transición de contexto' },
]

interface Props {
  /** Carga la formula en el editor del reproductor, la ejecuta y cambia de vista. */
  onOpenInPlayer: (formula: string) => void
}

const PREFIX = 'lesson'

export function ContextsView({ onOpenInPlayer }: Props) {
  const [lesson, setLesson] = useState<Lesson>('filtro')

  return (
    <div className="contexts">
      <Segmented items={LESSONS} value={lesson} onChange={setLesson} label="Lecciones" idPrefix={PREFIX} />
      {lesson === 'filtro' && <FilterContextLesson idPrefix={PREFIX} onOpenInPlayer={onOpenInPlayer} />}
      {lesson === 'fila' && <RowContextLesson idPrefix={PREFIX} onOpenInPlayer={onOpenInPlayer} />}
      {lesson === 'transicion' && <TransitionLesson idPrefix={PREFIX} onOpenInPlayer={onOpenInPlayer} />}
    </div>
  )
}
