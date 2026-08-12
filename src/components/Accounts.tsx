// Connecting and disconnecting Google accounts. The connect flow lives entirely in `useAccounts`:
// this panel calls it and then shows what is happening, including the two escape hatches for when
// the system browser did not open by itself.
//
// Disconnecting is the destructive one. It revokes the token and wipes every row belonging to the
// account, so it asks first and says what goes.

import { useEffect, useState } from "react";
import { useEscapeLayer } from "../escape";
import type { Account } from "../ipc";
import { useAccounts } from "../store/useAccounts";
import { useCalendarView } from "../store/useCalendarView";
import { useOverlays } from "../store/useOverlays";
import { Icon } from "./Icon";
import { Confirm, Sheet } from "./overlayShell";

const COPY = "M9 9h10v11H9zM5 15H4V4h11v1";
const OPEN = "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3";

export function Accounts() {
  const open = useOverlays((s) => s.open);
  const close = useOverlays((s) => s.close);
  const accounts = useAccounts((s) => s.accounts);
  const calendars = useAccounts((s) => s.calendars);
  const phase = useAccounts((s) => s.phase);
  const error = useAccounts((s) => s.error);
  const authUrl = useAccounts((s) => s.authUrl);
  const connect = useAccounts((s) => s.connect);
  const cancelConnect = useAccounts((s) => s.cancelConnect);
  const openAuthUrl = useAccounts((s) => s.openAuthUrl);
  const copyAuthUrl = useAccounts((s) => s.copyAuthUrl);
  const disconnect = useAccounts((s) => s.disconnect);
  const refresh = useAccounts((s) => s.refresh);

  const [confirming, setConfirming] = useState<Account | null>(null);
  const showing = open === "accounts";
  const connecting = phase === "connecting";

  // While the browser has the flow, Escape belongs to the flow rather than to the panel.
  useEscapeLayer(showing && connecting, cancelConnect);
  useEscapeLayer(showing && confirming !== null, () => setConfirming(null));

  useEffect(() => {
    if (showing) void refresh();
  }, [showing, refresh]);

  const remove = async (account: Account) => {
    setConfirming(null);
    await disconnect(account.id);
    void useCalendarView.getState().load();
  };

  const countFor = (accountId: string) => calendars.filter((c) => c.accountId === accountId).length;

  return (
    <Sheet
      open={showing}
      title="Google accounts"
      onClose={close}
      foot={
        confirming ? undefined : (
          <button
            type="button"
            className="panel-button"
            data-variant="primary"
            data-autofocus=""
            disabled={connecting || phase === "working"}
            onClick={() => void connect()}
          >
            Connect a Google account
          </button>
        )
      }
    >
      {confirming ? (
        <Confirm
          title={`Disconnect ${confirming.email}?`}
          body={
            <p>
              The token is revoked and every calendar, event and pending write stored on this
              computer for that Google account is deleted. Nothing changes in Google Calendar
              itself, and you can connect it again afterwards.
            </p>
          }
          confirmLabel="Disconnect"
          busy={phase === "working"}
          onConfirm={() => void remove(confirming)}
          onCancel={() => setConfirming(null)}
        />
      ) : (
        <>
          {connecting && (
            <div className="connect-pending">
              <span className="connect-line">Waiting for Google in your browser.</span>
              <span className="connect-note">
                {authUrl
                  ? "If nothing opened, use the link. Finish there and this comes back on its own."
                  : "Building the consent link."}
              </span>
              <div className="connect-actions">
                <button
                  type="button"
                  className="panel-button"
                  disabled={!authUrl}
                  onClick={openAuthUrl}
                >
                  <Icon d={OPEN} size={14} />
                  Open the link
                </button>
                <button
                  type="button"
                  className="panel-button"
                  disabled={!authUrl}
                  onClick={() => void copyAuthUrl()}
                >
                  <Icon d={COPY} size={14} />
                  Copy the link
                </button>
                <button type="button" className="panel-button" onClick={cancelConnect}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {phase === "error" && error && <p className="panel-note" data-error="">{error}</p>}

          {accounts.length === 0 && !connecting ? (
            <p className="panel-note">
              Connect a Google account to see its calendars here. Nothing syncs until you do.
            </p>
          ) : (
            accounts.map((account) => (
              <div className="account-row" key={account.id}>
                <span className="account-text">
                  <span className="account-email">{account.email}</span>
                  <span className="account-meta">
                    {account.connected ? `${countFor(account.id)} calendar${countFor(account.id) === 1 ? "" : "s"}` : "Needs reconnecting"}
                  </span>
                </span>
                <button
                  type="button"
                  className="panel-button"
                  data-variant="danger"
                  disabled={phase === "working"}
                  onClick={() => setConfirming(account)}
                >
                  Disconnect
                </button>
              </div>
            ))
          )}
        </>
      )}
    </Sheet>
  );
}

export default Accounts;
