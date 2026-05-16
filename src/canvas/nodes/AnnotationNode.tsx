/**
 * AnnotationNode — sticky note on the canvas.
 * Dark-tinted card variant: keeps color semantics (yellow=note, blue=question,
 * green=approved, pink=blocked, gray=neutral) but doesn't out-shout the actual
 * flow nodes on a #09090d canvas. The colored 2px left edge carries the family
 * signal; the body is tinted dark.
 */
import { useState, useRef, useEffect } from 'react'
import { useCanvasStore } from '../../store'

interface Props {
  id:       string
  selected: boolean
  data:     Record<string, unknown>
}

interface PaletteEntry {
  key:    string
  hue:    string   // CSS color used for left edge + label
  label:  string   // small uppercase header inside the note
  fill:   string   // semi-transparent body fill
  border: string   // semi-transparent border
}

// Use the same hues that match the rest of the canvas palette so the
// annotation feels like part of the system instead of a sticky-note overlay.
const COLORS: PaletteEntry[] = [
  { key: 'yellow', hue: '#eab308', label: 'note',     fill: 'rgba(234,179,8,0.08)',  border: 'rgba(234,179,8,0.28)' },
  { key: 'blue',   hue: '#60a5fa', label: 'question', fill: 'rgba(59,130,246,0.06)', border: 'rgba(59,130,246,0.28)' },
  { key: 'green',  hue: '#4ade80', label: 'approved', fill: 'rgba(74,222,128,0.06)', border: 'rgba(74,222,128,0.28)' },
  { key: 'pink',   hue: '#f472b6', label: 'blocked',  fill: 'rgba(236,72,153,0.06)', border: 'rgba(236,72,153,0.28)' },
  { key: 'gray',   hue: '#8080a0', label: 'note',     fill: 'rgba(128,128,160,0.06)', border: 'rgba(128,128,160,0.28)' },
]

export function AnnotationNode({ id, selected, data }: Props) {
  const updateNodeData = useCanvasStore((s) => s.updateNodeData)
  const deleteNode     = useCanvasStore((s) => s.deleteNode)
  const selectNode     = useCanvasStore((s) => s.selectNode)

  const text     = (data.text     as string) ?? ''
  const colorKey = (data.colorKey as string) ?? 'yellow'
  const color    = COLORS.find((c) => c.key === colorKey) ?? COLORS[0]

  const [editing, setEditing]   = useState(!text)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus()
      textareaRef.current.select()
    }
  }, [editing])

  return (
    <div
      className="nodrag annotation"
      onClick={() => selectNode(id)}
      style={{
        background:    color.fill,
        border:        `0.5px solid ${color.border}`,
        borderLeft:    `2px solid ${color.hue}`,
        borderRadius:  8,
        padding:       '8px 11px',
        minWidth:      170,
        maxWidth:      300,
        minHeight:     54,
        boxShadow:     selected
          ? `0 0 0 1.5px ${color.hue}55, 0 2px 8px rgba(0,0,0,0.4)`
          : '0 1px 4px rgba(0,0,0,0.35)',
        position:      'relative',
        cursor:        'default',
        transition:    'box-shadow 0.12s, border-color 0.12s',
        color:         'var(--text-primary)',
      }}
    >
      {/* Header tag — color-coded label inside the note itself */}
      <div style={{
        fontFamily: 'var(--font-mono)', fontSize: 9,
        color: color.hue, marginBottom: 4,
        letterSpacing: '.06em', textTransform: 'uppercase',
        fontWeight: 600,
      }}>
        {color.label}
      </div>

      {/* Toolbar — only when selected */}
      {selected && (
        <div style={{
          position: 'absolute', top: -32, left: 0,
          display: 'flex', gap: 3, background: 'var(--bg-raised)',
          border: '0.5px solid var(--border-mid)', borderRadius: 6,
          padding: '2px 4px', alignItems: 'center',
          boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
        }}>
          {COLORS.map((c) => (
            <button
              key={c.key}
              onClick={(e) => { e.stopPropagation(); updateNodeData(id, { colorKey: c.key }) }}
              style={{
                width: 14, height: 14, borderRadius: '50%',
                background: c.hue,
                border: `1.5px solid ${c.hue}`,
                cursor: 'pointer',
                outline: colorKey === c.key ? `2px solid ${c.hue}88` : 'none',
                outlineOffset: 1,
              }}
              title={c.label}
            />
          ))}
          <div style={{ width: 1, height: 14, background: 'var(--border-mid)', margin: '0 3px' }} />
          <button
            onClick={(e) => { e.stopPropagation(); setEditing(true) }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11,
                     color: 'var(--text-secondary)', padding: '0 2px' }}
            title="Edit text"
          >✎</button>
          <button
            onClick={(e) => { e.stopPropagation(); deleteNode(id) }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11,
                     color: '#ef4444', padding: '0 2px' }}
            title="Delete"
          >✕</button>
        </div>
      )}

      {editing ? (
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => updateNodeData(id, { text: e.target.value })}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false) }}
          rows={3}
          placeholder="Add a note…"
          style={{
            width: '100%', background: 'transparent', border: 'none', outline: 'none',
            resize: 'none', fontFamily: 'var(--font-sans)', fontSize: 11.5,
            color: 'var(--text-primary)', lineHeight: 1.55,
          }}
        />
      ) : (
        <div
          onDoubleClick={() => setEditing(true)}
          style={{
            fontSize: 11.5, color: 'var(--text-primary)', lineHeight: 1.55,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            minHeight: 18, cursor: 'text',
          }}
        >
          {text || <span style={{ opacity: 0.4 }}>Double-click to edit…</span>}
        </div>
      )}
    </div>
  )
}
