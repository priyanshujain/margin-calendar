// What a first launch says. With nothing connected the grid is a correct and completely empty
// calendar, which looks exactly like a calendar you have nothing in, so the one thing to do next
// went unsaid: the panel that does it is behind a key on the desktop and an overflow sheet on a
// phone, and neither is somewhere you look when you do not yet know it exists.
//
// It covers the grid rather than sitting beside it. There is nothing underneath worth reading, and
// a note floating over an empty axis reads as a thing that failed to load.

import { runCommand } from "../keys/commands";
import { useAccounts } from "../store/useAccounts";

export function FirstRun() {
  const loaded = useAccounts((s) => s.loaded);
  const accounts = useAccounts((s) => s.accounts);

  if (!loaded || accounts.length > 0) return null;

  return (
    <div className="first-run">
      <div className="first-run-text">
        <h2 className="first-run-title">No Google account connected</h2>
        <p className="first-run-note">
          Connect one and the calendars on it show up here. Nothing syncs until you do.
        </p>
        <button
          type="button"
          className="panel-button"
          data-variant="primary"
          onClick={() => runCommand("accounts")}
        >
          Connect a Google account
        </button>
      </div>
    </div>
  );
}

export default FirstRun;
