import { useState } from 'react'
import { Collapsible } from './Collapsible'
import type { FilterEntry, FilterOrigin, RelationshipState, RelationshipStatus, RowContextEntry } from '../engine'
import { columnTypeOf, formatPlain, formatValue } from './format'

const ORIGIN_TAG: Partial<Record<FilterOrigin, string>> = {
  added: 'nuevo',
  replaced: 'reemplaza',
  removed: 'quitado',
}

const MAX_ROWS = 8

function FilterCard({ entry }: { entry: FilterEntry }) {
  const shown = entry.rows.slice(0, MAX_ROWS)
  const hidden = entry.rows.length - shown.length
  const tag = ORIGIN_TAG[entry.origin]
  return (
    <li className={`ctx-card origin-${entry.origin}`}>
      <div className="ctx-card-head">
        <span className="ctx-cols">{entry.columns.join(', ')}</span>
        {tag && <span className="origin-tag">{tag}</span>}
      </div>
      <table className="ctx-table">
        <thead>
          <tr>
            {entry.columns.map((c) => (
              <th key={c} scope="col">
                {c.replace(/^.*\[(.*)\]$/, '$1')}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i}>
              {row.map((v, j) => (
                <td key={j}>{formatValue(v, columnTypeOf(entry.columns[j] ?? ''))}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {hidden > 0 && <p className="ctx-more">y {hidden} más</p>}
    </li>
  )
}

export function FilterContext({ entries, title = 'Contexto de filtro' }: { entries: FilterEntry[]; title?: string }) {
  return (
    <section className="ctx-block" aria-labelledby="ctx-filter-title">
      <h3 id="ctx-filter-title">{title}</h3>
      {entries.length === 0 ? (
        <p className="ctx-empty">Sin filtros: todas las filas son visibles</p>
      ) : (
        <ul className="ctx-list">
          {entries.map((e) => (
            <FilterCard key={e.id} entry={e} />
          ))}
        </ul>
      )}
    </section>
  )
}

export function RowContext({ entries }: { entries: RowContextEntry[] }) {
  return (
    <section className="ctx-block" aria-labelledby="ctx-row-title">
      <h3 id="ctx-row-title">Contexto de fila</h3>
      {entries.length === 0 ? (
        <p className="ctx-empty">No hay fila actual</p>
      ) : (
        <ul className="ctx-list">
          {entries.map((e, i) => (
            <li key={`${e.table}-${i}`} className="ctx-card row-ctx" style={{ marginInlineStart: `${i * 0.75}rem` }}>
              <span className="ctx-cols">{e.table}</span>
              <ul className="pairs">
                {e.values.map((v) => (
                  <li key={v.column}>
                    <span className="pair-col">{v.column}</span>
                    <span className="pair-eq"> = </span>
                    <span className="pair-val">{formatPlain(v.value, columnTypeOf(`${e.table}[${v.column}]`))}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

const REL_STATUS_TEXT: Record<RelationshipStatus, string> = {
  active: 'activa',
  inactive: 'inactiva',
  activated: 'activada',
  deactivated: 'desactivada',
}

function RelationshipRow({ rel }: { rel: RelationshipState }) {
  const dashed = rel.status === 'inactive' || rel.status === 'deactivated'
  const changed = rel.status === 'activated' || rel.status === 'deactivated'
  return (
    <li className={`rel-row status-${rel.status}${rel.used ? ' is-used' : ''}`}>
      <svg className={`rel-stroke${dashed ? ' is-dashed' : ''}`} width="22" height="8" viewBox="0 0 22 8" aria-hidden="true">
        <line x1="1" y1="4" x2="21" y2="4" />
      </svg>
      <span className="rel-text">
        {rel.from} <span className="rel-arrow">-&gt;</span> {rel.to}
      </span>
      <span className="rel-tags">
        {rel.used && <span className="origin-tag rel-used">en uso</span>}
        {changed ? (
          <span className={`origin-tag rel-${rel.status}`}>{REL_STATUS_TEXT[rel.status]}</span>
        ) : (
          <span className="rel-state">{REL_STATUS_TEXT[rel.status]}</span>
        )}
      </span>
    </li>
  )
}

export function RelationshipsContext({ entries }: { entries: RelationshipState[] | undefined }) {
  const [showAll, setShowAll] = useState(false)
  if (!entries || entries.length === 0) return null
  const important = (r: RelationshipState) => !!r.used || r.status === 'activated' || r.status === 'deactivated'
  const first = entries.filter(important)
  const rest = entries.filter((r) => !important(r))
  return (
    <Collapsible
      id="ctx-rel"
      title="Relaciones"
      className="ctx-block"
      headingLevel={3}
      meta={entries.length}
      forceOpen={first.length > 0}
      flag={first.some((r) => r.used) ? 'en uso' : 'cambio'}
    >
      <ul className="ctx-list rel-list">
        {first.map((r) => (
          <RelationshipRow key={`${r.from}|${r.to}`} rel={r} />
        ))}
        {showAll &&
          rest.map((r) => <RelationshipRow key={`${r.from}|${r.to}`} rel={r} />)}
      </ul>
      {rest.length > 0 && (
        <button type="button" className="link-btn rel-more" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Ocultar las demás' : first.length === 0 ? `Ver todas (${entries.length})` : `Ver las demás (${rest.length})`}
        </button>
      )}
    </Collapsible>
  )
}
