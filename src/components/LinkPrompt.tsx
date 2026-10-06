// A description link is written by whoever put the event on the calendar, so the reader sees
// where it goes before the browser does.

import { useLinkPrompt } from "../store/useLinkPrompt";
import { Confirm } from "./overlayShell";
import { openLink } from "./RichText";

export function LinkPrompt() {
  const url = useLinkPrompt((s) => s.url);
  const dismiss = useLinkPrompt((s) => s.dismiss);
  if (!url) return null;

  return (
    <div
      className="overlay link-prompt"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div className="panel link-prompt-panel" role="alertdialog" aria-modal="true">
        <Confirm
          title="Do you want to open this page?"
          body={<p className="link-prompt-url">{url}</p>}
          confirmLabel="Open"
          variant="primary"
          onConfirm={() => {
            dismiss();
            openLink(url);
          }}
          onCancel={dismiss}
        />
      </div>
    </div>
  );
}

export default LinkPrompt;
