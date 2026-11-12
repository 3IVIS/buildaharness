import { SETUP_GUIDES } from '@buildaharness/aielia'

/**
 * Shown on the hosted Write page until the visitor has added their own AI key. The article underneath is a sample held in memory, so without
 * this a first-time visitor cannot tell that nothing will answer until they bring a key. One line, kept small.
 */
export function SampleNotice({ onAddKey }: { onAddKey: () => void }): React.JSX.Element {
  return (
    <div className="write__sample" role="note">
      <span className="write__sample-text">
        <strong>Sample.</strong> Add your AI key to use Aielia on your own articles.
        <span className="write__sample-more"> It stays in this browser. <a href={SETUP_GUIDES.openrouter.url} target="_blank" rel="noopener noreferrer">How to get a key</a></span>
      </span>
      <button type="button" className="write__sample-add" onClick={onAddKey}>Add your key</button>
    </div>
  )
}
