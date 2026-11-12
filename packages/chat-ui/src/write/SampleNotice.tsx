import { SETUP_GUIDES } from '@buildaharness/aielia'

/**
 * Shown on the hosted Write page until the visitor has added their own AI key. The article underneath is a sample held in memory, so without
 * this a first-time visitor cannot tell that nothing will answer until they bring a key.
 */
export function SampleNotice({ onAddKey, onReset }: { onAddKey: () => void; onReset: () => void }): React.JSX.Element {
  return (
    <div className="write__sample" role="note">
      <div className="write__sample-text">
        <strong>This is a sample.</strong>
        <span>
          Edit the text by hand, or add your AI key to use Aielia on your own articles. The key stays in this browser.{' '}
          <a href={SETUP_GUIDES.openrouter.url} target="_blank" rel="noopener noreferrer">How to get a key</a>
        </span>
      </div>
      <div className="write__sample-actions">
        <button type="button" className="write__sample-reset" onClick={onReset}>Reset sample</button>
        <button type="button" className="write__sample-add" onClick={onAddKey}>Add your key</button>
      </div>
    </div>
  )
}
