import type { RowStatus, SnapshotRow, TableRole, TableSnapshot } from '../engine'
import { CheckIcon } from './icons'
import { formatValue } from './format'
import { useGhosts } from './useGhosts'

const ROLE_LABEL: Record<TableRole, string> = {
  source: 'Origen',
  working: 'En proceso',
  filter: 'Filtro',
  result: 'Resultado',
}

const STATUS_LABEL: Record<RowStatus, string> = {
  normal: '',
  active: 'Evaluando',
  kept: 'Conservada',
  removed: 'Descartada',
  added: 'Nueva',
}

const rowKey = (row: SnapshotRow) => row.key

interface Props {
  table: TableSnapshot
  leaving?: boolean
  /** Letra (A, B...) que vincula la tabla con un resultado parcial. */
  marker?: string
}

export function DataTable({ table, leaving = false, marker }: Props) {
  const rows = useGhosts(table.rows, rowKey)
  const hasNotes = rows.some((r) => r.item.note)

  return (
    <section
      className={`table-card role-${table.role}${leaving ? ' is-leaving' : ''}`}
      aria-label={table.title}
    >
      <header className="table-head">
        <h3>
          {marker && (
            <span className={`mark-dot tone-${marker.toLowerCase()}`} title={`Tabla ${marker}`}>
              {marker}
            </span>
          )}
          {table.title}
        </h3>
        <span className="role-tag">{ROLE_LABEL[table.role]}</span>
      </header>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th className="mark-col" aria-label="Estado" />
              {table.columns.map((col, i) => (
                <th
                  key={`${col.name}-${i}`}
                  scope="col"
                  className={`${col.highlight ? 'is-highlight' : ''}${col.isNew ? ' is-new' : ''}`}
                >
                  {col.name}
                  {col.isNew && <span className="new-tag">nueva</span>}
                </th>
              ))}
              {hasNotes && <th className="note-col" aria-label="Nota" />}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item: row, leaving: rowLeaving }) => (
              <tr key={row.key} className={`status-${row.status}${rowLeaving ? ' is-leaving' : ''}`}>
                <td className="mark-col">
                  {row.status === 'kept' && <CheckIcon />}
                  {STATUS_LABEL[row.status] && <span className="sr-only">{STATUS_LABEL[row.status]}</span>}
                </td>
                {row.cells.map((cell, i) => (
                  <td
                    key={i}
                    className={`${typeof cell === 'number' ? 'num' : ''}${table.columns[i]?.highlight ? ' is-highlight' : ''}`}
                  >
                    {formatValue(cell, table.columns[i]?.type)}
                  </td>
                ))}
                {hasNotes && <td className="note-col">{row.note}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
