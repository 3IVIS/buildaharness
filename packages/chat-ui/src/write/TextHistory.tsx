import { revisionsOfText, type SelectionRange, type VersionText } from '@buildaharness/aielia'

interface Props {
  markdown: string
  selection: SelectionRange | null
  versions: readonly VersionText[]
}

const clip = (t: string, n = 400): string => (t.length > n ? `${t.slice(0, n)}…` : t)

/** How the selected sentence, paragraph or section read in each saved version, newest first; a version where it did not change is not repeated. */
export function TextHistory({ markdown, selection, versions }: Props): React.JSX.Element {
  const r = selection ? revisionsOfText(markdown, selection, versions) : undefined
  if (!r) return <p className="write__muted">Click in the text, or highlight some, to see how it read in earlier versions.</p>
  const [, ...before] = r.revisions
  return (
    <>
      <p className="write__muted">{before.length === 0 ? `This ${r.unit} has not changed in any saved version.` : `${before.length} earlier wording${before.length === 1 ? '' : 's'} of this ${r.unit}:`}</p>
      <ul className="write__rows write__revisions">
        {before.map((v) => (
          <li key={v.index}>
            <div className="write__rowmain">
              <div className="write__hline"><strong>{v.label ?? (v.kind === 'published' ? 'Published' : 'Saved')}</strong><time dateTime={v.at}>{v.at ? new Date(v.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}</time></div>
              <div className="write__revtext">{v.text === undefined ? <span className="write__muted">Not in this version.</span> : clip(v.text)}</div>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
