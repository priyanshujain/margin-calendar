// A parsed description, as elements rather than as source.
//
// The deciding is all done by the time a tree gets here: `parseDescription` in
// `EventDetailsHtml.ts` has already thrown away every tag outside its vocabulary, every attribute
// but a scheme-checked `href`, and everything `<script>` and `<style>` were carrying. This walk
// only chooses which element each node becomes, and text stays text, which React escapes. Nothing
// on this path can reach `dangerouslySetInnerHTML`, and nothing should ever be added that does.
//
// The event details card has the same walk inline. This is the shared copy, so the editor's
// read-only view and anything else that has to print a description agree on what one looks like.

import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "../ipc";
import { notify } from "../store/useToast";
import type { DescNode, DescTag } from "./EventDetailsHtml";
import "../styles/rich.css";

/** The parser's vocabulary, and the only elements a description can put on screen. */
const ELEMENT: Record<Exclude<DescTag, "a">, "div" | "ul" | "ol" | "li" | "strong" | "em" | "u" | "s" | "code"> = {
  block: "div",
  ul: "ul",
  ol: "ol",
  li: "li",
  b: "strong",
  i: "em",
  u: "u",
  s: "s",
  code: "code",
};

/** The keys are indices because the tree is built once from an immutable string and never reordered. */
export function RichText({ nodes }: { nodes: readonly DescNode[] }) {
  return (
    <>
      {nodes.map((node, at) => {
        if (node.kind === "text") return node.text;
        if (node.kind === "break") return <br key={at} />;
        if (node.tag === "a") {
          // A real anchor, so it is focusable and announces itself as a link, but the navigation is
          // ours: letting the webview follow it would replace the app with a web page and leave no
          // way back. `openLink` sends it to the browser instead.
          return (
            <a
              key={at}
              className="rich-link"
              href={node.href}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => {
                e.preventDefault();
                if (node.href) openLink(node.href);
              }}
              // Middle click never reaches `onClick`, and a webview asked to open a second window
              // is its own kind of stranded. Same destination, same way out.
              onAuxClick={(e) => {
                e.preventDefault();
                if (e.button === 1 && node.href) openLink(node.href);
              }}
            >
              <RichText nodes={node.children} />
            </a>
          );
        }
        const Tag = ELEMENT[node.tag];
        return (
          <Tag key={at}>
            <RichText nodes={node.children} />
          </Tag>
        );
      })}
    </>
  );
}

/** Tauri opens it in the real browser. In a dev browser there is no plugin, so the tab does. */
export function openLink(uri: string): void {
  if (!isTauri) {
    window.open(uri, "_blank", "noopener,noreferrer");
    return;
  }
  openUrl(uri).catch((e) => notify(`Could not open the link: ${e}`));
}

export default RichText;
