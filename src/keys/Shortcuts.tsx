// The `?` sheet, generated from the binding table. There is no list of shortcuts anywhere in this
// file, which is the entire point: a binding that exists is documented, and one that is removed
// stops being documented, without anybody remembering to do either.

import { Sheet } from "../components/overlayShell";
import { useOverlays } from "../store/useOverlays";
import "../styles/palette.css";
import { BINDINGS, GROUPS, bindingLabel, keyLabel } from "./bindings";
import { commandLabel } from "./commands";

export function ShortcutsSheet() {
  const open = useOverlays((s) => s.open);
  const close = useOverlays((s) => s.close);

  return (
    <Sheet open={open === "shortcuts"} title="Keyboard shortcuts" size="wide" onClose={close}>
      <div className="shortcuts">
        {GROUPS.map((group) => {
          const rows = BINDINGS.filter((binding) => binding.group === group);
          if (rows.length === 0) return null;
          return (
            <section className="shortcuts-group" key={group}>
              <h3 className="shortcuts-heading">{group}</h3>
              <dl className="shortcuts-list">
                {rows.map((binding) => (
                  <div className="shortcuts-row" key={binding.keys.join(" ")}>
                    <dt className="shortcuts-keys">
                      {binding.keys.map((key) => (
                        <kbd className="key" key={key}>
                          {keyLabel(key)}
                        </kbd>
                      ))}
                    </dt>
                    <dd className="shortcuts-label">{bindingLabel(binding, commandLabel)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          );
        })}
      </div>
      <p className="shortcuts-note">
        Nothing is modal and nothing is chorded. Keys stand back while a text field has the focus.
      </p>
    </Sheet>
  );
}

export default ShortcutsSheet;
