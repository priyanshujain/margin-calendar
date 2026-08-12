// Which calendars the grid draws, grouped by the account they came from. The checkbox writes
// straight through `useAccounts.setSelected`, which is already optimistic and reverts itself on a
// failure, so there is nothing to hold here.
//
// A calendar you do not own behaves differently once you try to edit it, so its role is on the
// row rather than hidden behind the event that will refuse to save.

import { useEffect, useMemo } from "react";
import type { Calendar } from "../ipc";
import { useAccounts } from "../store/useAccounts";
import { useCalendarView } from "../store/useCalendarView";
import { useOverlays } from "../store/useOverlays";
import { calSlot } from "./GridModel";
import { roleLabel } from "./overlayModel";
import { Sheet } from "./overlayShell";

interface Group {
  accountId: string;
  email: string;
  calendars: Calendar[];
}

function group(calendars: readonly Calendar[], emails: ReadonlyMap<string, string>): Group[] {
  const groups = new Map<string, Group>();
  for (const calendar of calendars) {
    let g = groups.get(calendar.accountId);
    if (!g) {
      g = {
        accountId: calendar.accountId,
        email: emails.get(calendar.accountId) ?? "Disconnected account",
        calendars: [],
      };
      groups.set(calendar.accountId, g);
    }
    g.calendars.push(calendar);
  }
  for (const g of groups.values()) {
    g.calendars.sort(
      (a, b) => Number(b.primary) - Number(a.primary) || a.summary.localeCompare(b.summary),
    );
  }
  return [...groups.values()].sort((a, b) => a.email.localeCompare(b.email));
}

export function CalendarList() {
  const open = useOverlays((s) => s.open);
  const close = useOverlays((s) => s.close);
  const show = useOverlays((s) => s.show);
  const accounts = useAccounts((s) => s.accounts);
  const calendars = useAccounts((s) => s.calendars);
  const setSelected = useAccounts((s) => s.setSelected);
  const refresh = useAccounts((s) => s.refresh);

  const showing = open === "calendars";

  useEffect(() => {
    if (showing) void refresh();
  }, [showing, refresh]);

  const groups = useMemo(
    () => group(calendars, new Map(accounts.map((a) => [a.id, a.email]))),
    [calendars, accounts],
  );

  const toggle = (calendar: Calendar) => {
    void setSelected(calendar.id, !calendar.selected);
    // The instance stream is filtered on the Rust side, so the span has to be asked for again.
    void useCalendarView.getState().load();
  };

  return (
    <Sheet open={showing} title="Calendars" onClose={close}>
      {groups.length === 0 ? (
        <div className="panel-empty">
          <p>No calendars here yet.</p>
          <button type="button" className="panel-button" onClick={() => show("accounts")}>
            Connect an account
          </button>
        </div>
      ) : (
        groups.map((g) => (
          <div className="cal-group" key={g.accountId}>
            <span className="field-label">{g.email}</span>
            {g.calendars.map((calendar) => {
              const role = roleLabel(calendar.accessRole);
              return (
                <label className="cal-row" key={calendar.id} title={calendar.description ?? undefined}>
                  <input
                    type="checkbox"
                    className="cal-check"
                    checked={calendar.selected}
                    onChange={() => toggle(calendar)}
                  />
                  <span
                    className="cal-dot"
                    style={{ background: `var(--cal-${calSlot(calendar.colorHex, calendar.id)})` }}
                  />
                  <span className="cal-name">{calendar.summary || "Untitled"}</span>
                  {role ? <span className="cal-role">{role}</span> : null}
                </label>
              );
            })}
          </div>
        ))
      )}
    </Sheet>
  );
}

export default CalendarList;
