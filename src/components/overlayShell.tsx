// The chrome every overlay shares: margin's `.overlay` and `.panel` idiom, an escape layer, a
// backdrop that dismisses on a click, and a close button carrying its own shortcut.
//
// Nothing is resident, so a closed sheet renders nothing at all and its children mount fresh on
// the next open. That is deliberate: it is what keeps the form state in each panel from having to
// be reset by hand.

import { useEffect, useRef, type ReactNode } from "react";
import { useEscapeLayer } from "../escape";
import "../styles/overlays.css";
import { useOverlays } from "../store/useOverlays";
import { Icon } from "./Icon";

const CLOSE = "M18 6 6 18M6 6l12 12";
const BACK = "M19 12H5M12 19l-7-7 7-7";

export interface SheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  /** `mini` is the month popover width, `wide` the editor. */
  size?: "mini" | "default" | "wide";
  foot?: ReactNode;
  children: ReactNode;
}

const TITLES: Record<string, string> = {
  palette: "the command palette",
  search: "search",
  calendars: "calendars",
  "mini-month": "the calendar",
  editor: "the event",
  accounts: "Google accounts",
  settings: "settings",
  shortcuts: "shortcuts",
  menu: "the menu",
};

export function Sheet({ open, title, onClose, size = "default", foot, children }: SheetProps) {
  const trail = useOverlays((s) => s.trail);
  const back = useOverlays((s) => s.back);
  const canGoBack = trail.length > 0;
  const backLabel = TITLES[trail[trail.length - 1] ?? ""] ?? "the last panel";

  // Escape retraces the way in rather than throwing away every panel at once. With nowhere to go
  // back to it closes, which is what it always did.
  useEscapeLayer(open, canGoBack ? back : onClose);
  const panel = useRef<HTMLDivElement | null>(null);

  // Focus has to leave the grid or the first keystroke goes to the keymap instead of the panel.
  useEffect(() => {
    if (!open) return;
    const el = panel.current;
    if (!el) return;
    (el.querySelector<HTMLElement>("[data-autofocus]") ?? el).focus();
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="panel overlay-panel"
        data-size={size}
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="panel-head">
          {canGoBack && (
            <button
              type="button"
              className="icon-button panel-back"
              title={`Back to ${backLabel} (⎋)`}
              aria-label={`Back to ${backLabel}`}
              onClick={back}
            >
              <Icon d={BACK} />
            </button>
          )}
          <h2>{title}</h2>
          <button type="button" className="icon-button" title="Close (⎋)" onClick={onClose}>
            <Icon d={CLOSE} />
          </button>
        </div>
        <div className="panel-body">{children}</div>
        {foot ? <div className="panel-foot">{foot}</div> : null}
      </div>
    </div>
  );
}

/** A destructive step in front of the panel it belongs to. The layer above unwinds first. */
export interface ConfirmProps {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function Confirm({ title, body, confirmLabel, busy, onConfirm, onCancel }: ConfirmProps) {
  useEscapeLayer(true, onCancel);
  const cancel = useRef<HTMLButtonElement | null>(null);

  // The safe option takes the focus, so a stray Enter does nothing destructive.
  useEffect(() => cancel.current?.focus(), []);

  return (
    <div className="confirm">
      <h3 className="confirm-title">{title}</h3>
      <div className="confirm-body">{body}</div>
      <div className="confirm-actions">
        <button type="button" className="panel-button" ref={cancel} onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="panel-button"
          data-variant="danger"
          disabled={busy}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
