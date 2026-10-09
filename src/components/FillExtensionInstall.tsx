import { downloadFillExtension, fillExtensionVersion } from '../fillExtension/bundle'

/**
 * Where the owner gets the extension a send session runs on. Chrome only loads
 * an unpacked extension from a folder on disk, so this is a download plus the
 * four clicks that load it — on whichever machine they're sending from.
 */
export function FillExtensionInstall() {
  return (
    <details className="jp-fill-install">
      <summary>Install the hadoku Fill extension (v{fillExtensionVersion})</summary>
      <p>
        Send sessions need it: it fills each form in your own Chrome. It never presses Submit or
        types a code.
      </p>
      <ol>
        <li>
          <button
            type="button"
            className="jp-fill-install__download"
            onClick={downloadFillExtension}
          >
            Download hadoku-fill-{fillExtensionVersion}.zip
          </button>{' '}
          and unzip it into a folder you&apos;ll keep — Chrome loads it from there.
        </li>
        <li>
          Open <code>chrome://extensions</code> and turn on <strong>Developer mode</strong>.
        </li>
        <li>
          Press <strong>Load unpacked</strong> and choose the folder.
        </li>
        <li>Stay signed in to hadoku.me in that Chrome profile.</li>
      </ol>
      <p className="jp-fill-install__update">
        To update: unzip the new download over the same folder, then press ↻ on the extension.
      </p>
    </details>
  )
}
