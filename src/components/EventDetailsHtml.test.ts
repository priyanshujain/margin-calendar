// Two halves. The first is "does a real description come out looking like what it says", using the
// shapes Google actually sends. The second is the one that matters: hostile input, because this
// string comes off the wire from whoever put the event on the calendar, and the only reason it is
// safe to render is that this module refuses to carry anything but a known list of elements and one
// vetted attribute.

import { describe, expect, it } from "vitest";
import {
  decodeEntities,
  hasMarkup,
  parseDescription,
  safeHref,
  type DescElement,
  type DescNode,
} from "./EventDetailsHtml";

/** The visible words, which is what "never renders" is asserted against. */
function textOf(nodes: readonly DescNode[]): string {
  return nodes
    .map((node) =>
      node.kind === "text" ? node.text : node.kind === "break" ? "\n" : textOf(node.children),
    )
    .join("");
}

/** Every element in the tree, flattened, so a whitelist can be asserted over the whole thing. */
function elementsOf(nodes: readonly DescNode[]): DescElement[] {
  const out: DescElement[] = [];
  for (const node of nodes) {
    if (node.kind !== "element") continue;
    out.push(node);
    out.push(...elementsOf(node.children));
  }
  return out;
}

const parse = (raw: string): DescNode[] => parseDescription(raw).nodes;
const links = (raw: string): DescElement[] => elementsOf(parse(raw)).filter((e) => e.tag === "a");

describe("plain text", () => {
  it("keeps its newlines as breaks", () => {
    const nodes = parse("Bring the deck.\nRoom 3.\n\nAsk Sam first.");
    expect(nodes.map((n) => (n.kind === "text" ? n.text : "<br>"))).toEqual([
      "Bring the deck.",
      "<br>",
      "Room 3.",
      "<br>",
      "<br>",
      "Ask Sam first.",
    ]);
  });

  it("takes carriage returns and the Windows pair as one break each", () => {
    expect(textOf(parse("one\r\ntwo\rthree"))).toBe("one\ntwo\nthree");
  });

  it("is marked plain, so the card can keep its own spacing", () => {
    expect(parseDescription("  indented\n    more").plain).toBe(true);
    expect(parseDescription("a<br>b").plain).toBe(false);
  });

  it("keeps an angle bracket that is arithmetic rather than markup", () => {
    expect(hasMarkup("if a < b then 2 > 1")).toBe(false);
    expect(textOf(parse("if a < b then 2 > 1"))).toBe("if a < b then 2 > 1");
  });

  it("is nothing at all when it is empty or only whitespace", () => {
    expect(parse("")).toEqual([]);
    expect(parse("   \n  ")).toEqual([]);
    expect(parseDescription(null).nodes).toEqual([]);
    expect(parseDescription(undefined).nodes).toEqual([]);
  });
});

describe("html", () => {
  it("turns a br into a break", () => {
    expect(parse("Job List:<br>tomorrow")).toEqual([
      { kind: "text", text: "Job List:" },
      { kind: "break" },
      { kind: "text", text: "tomorrow" },
    ]);
    expect(parse("a<BR/>b")).toEqual([
      { kind: "text", text: "a" },
      { kind: "break" },
      { kind: "text", text: "b" },
    ]);
  });

  it("renders the description from the bug report as text and one link", () => {
    const url =
      "https://docs.google.com/spreadsheets/d/15rc9TXa46HwY3KsppvMR93T8L_7BTWacDnvisxPpzkE/edit?gid=71264683#gid=71264683";
    const nodes = parse(
      `Job List:<br><a href="${url}" class="pastedDriveLink-0">${url}</a>`,
    );
    expect(textOf(nodes)).toBe(`Job List:\n${url}`);
    const [link] = links(`Job List:<br><a href="${url}" class="pastedDriveLink-0">${url}</a>`);
    expect(link.href).toBe(url);
    // The class attribute is gone, and nothing else came with it.
    expect(Object.keys(link)).toEqual(["kind", "tag", "href", "children"]);
  });

  it("keeps the href of an anchor and the words inside it", () => {
    const [link] = links('<a href="https://example.com/a?b=1&amp;c=2">the sheet</a>');
    expect(link.href).toBe("https://example.com/a?b=1&c=2");
    expect(textOf(link.children)).toBe("the sheet");
  });

  it("takes a mailto link", () => {
    expect(links('<a href="mailto:sam@example.com">Sam</a>')[0].href).toBe("mailto:sam@example.com");
  });

  it("keeps emphasis, and normalises the tags that mean the same thing", () => {
    const tags = elementsOf(parse("<strong>a</strong><em>b</em><i>c</i><u>d</u><del>e</del>")).map(
      (e) => e.tag,
    );
    expect(tags).toEqual(["b", "i", "i", "u", "s"]);
  });

  it("keeps lists as lists", () => {
    const nodes = parse("<ul><li>first</li><li>second</li></ul>");
    expect(nodes).toHaveLength(1);
    const list = nodes[0] as DescElement;
    expect(list.tag).toBe("ul");
    expect(list.children.map((c) => (c as DescElement).tag)).toEqual(["li", "li"]);
    expect(textOf(list.children)).toBe("firstsecond");
    expect((parse("<ol><li>one</li></ol>")[0] as DescElement).tag).toBe("ol");
  });

  it("closes an item that the sender left open", () => {
    const list = parse("<ul><li>first<li>second</ul>")[0] as DescElement;
    expect(list.children).toHaveLength(2);
    expect(textOf(list.children[0].kind === "element" ? list.children[0].children : [])).toBe("first");
  });

  it("gathers loose content in a list into an item, so a ul only ever holds li", () => {
    const list = parse("<ul>stray<li>first</li></ul>")[0] as DescElement;
    expect(list.children.every((c) => c.kind === "element" && c.tag === "li")).toBe(true);
    expect(textOf([list])).toBe("strayfirst");
  });

  it("degrades an unknown tag to the text it wrapped", () => {
    expect(textOf(parse('<span style="color:red">red</span> and <font size=7>big</font>'))).toBe(
      "red and big",
    );
    expect(elementsOf(parse("<table><tr><td>cell</td></tr></table>"))).toEqual([]);
    expect(textOf(parse("<table><tr><td>cell</td></tr></table>"))).toBe("cell");
  });

  it("collapses whitespace the way html does, and keeps a hard space", () => {
    expect(textOf(parse("<div>a   \n   b</div>"))).toBe("a b");
    expect(textOf(parse("<div>a&nbsp;&nbsp;b</div>"))).toBe("a\u00a0\u00a0b");
  });

  it("decodes entities, named, decimal and hex", () => {
    expect(textOf(parse("<p>Tom &amp; Jerry &lt;b&gt; &#8364; &#x1F600; &quot;hi&quot;</p>"))).toBe(
      'Tom & Jerry <b> \u20ac \u{1F600} "hi"',
    );
  });

  it("leaves an entity it does not know exactly as it found it", () => {
    expect(decodeEntities("&zzz; &amp;")).toBe("&zzz; &");
    // Not a lookup on Object.prototype, whatever the name looks like.
    expect(decodeEntities("&constructor; &toString;")).toBe("&constructor; &toString;");
  });

  it("drops the padding a mail client leaves behind", () => {
    expect(parse("<br><br>Only this.<br><br><br><p>   </p>")).toEqual([
      { kind: "text", text: "Only this." },
    ]);
  });

  it("keeps a blank line in the middle, but not a run of six", () => {
    expect(parse("a<br><br><br><br>b").filter((n) => n.kind === "break")).toHaveLength(2);
  });

  it("survives tags that were never closed", () => {
    expect(textOf(parse("<div><b>bold <i>both"))).toBe("bold both");
    expect(textOf(parse("</b>stray close</div>"))).toBe("stray close");
  });

  it("survives a bare angle bracket next to real markup", () => {
    expect(textOf(parse("5 < 6 <b>really</b>"))).toBe("5 < 6 really");
  });

  it("drops comments and doctypes without dropping the text around them", () => {
    expect(textOf(parse("<!DOCTYPE html>before<!-- hidden -->after"))).toBe("beforeafter");
    expect(textOf(parse("before<!-- never closed"))).toBe("before");
  });
});

describe("hostile input", () => {
  it("never renders a script, and never its contents", () => {
    const nodes = parse("hello<script>alert(1)</script>bye");
    expect(textOf(nodes)).toBe("hellobye");
    expect(textOf(parse("<script>alert(1)"))).toBe("");
    expect(textOf(parse("<SCRIPT SRC=//evil.test/x.js></SCRIPT>ok"))).toBe("ok");
    // Nested inside something else the parser does not know, which is the usual smuggling route.
    expect(textOf(parse("<svg><script>alert(1)</script></svg>safe"))).toBe("safe");
  });

  it("never renders a style block", () => {
    expect(textOf(parse("<style>body{display:none}</style>text"))).toBe("text");
  });

  it("never renders an image, with or without an onerror", () => {
    const nodes = parse('<img src=x onerror="alert(1)">caption');
    expect(elementsOf(nodes)).toEqual([]);
    expect(textOf(nodes)).toBe("caption");
    expect(JSON.stringify(nodes)).not.toContain("onerror");
    expect(JSON.stringify(parse('<img src="x" onerror=alert(1) />'))).not.toContain("alert");
  });

  it("drops a javascript url and keeps the words that were the link", () => {
    const raw = '<a href="javascript:alert(1)">click me</a>';
    expect(links(raw)).toEqual([]);
    expect(textOf(parse(raw))).toBe("click me");
  });

  it("drops a javascript url however it is spelled", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "  javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "&#106;avascript:alert(1)",
      "&#x6A;avascript:alert(1)",
      "\u0000javascript:alert(1)",
      "jav&#x09;ascript:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "file:///etc/passwd",
      "//evil.test/x",
      "/relative/path",
      "#anchor",
      "",
    ]) {
      expect(safeHref(href), href).toBeNull();
    }
    expect(safeHref(null)).toBeNull();
  });

  it("keeps the schemes it does allow, and only those", () => {
    expect(safeHref("https://example.com/a b")).toBe("https://example.com/ab");
    expect(safeHref("HTTP://Example.com")).toBe("HTTP://Example.com");
    expect(safeHref("mailto:sam@example.com?subject=hi")).toBe("mailto:sam@example.com?subject=hi");
  });

  it("carries no attribute other than the href of a link", () => {
    const raw =
      '<a href="https://ok.test" onclick="steal()" onmouseover="steal()" target="_top" style="x">x</a>' +
      '<div onload="steal()" id="q"><b class="c">y</b></div>';
    const nodes = parse(raw);
    for (const element of elementsOf(nodes)) {
      const keys = Object.keys(element).filter((k) => k !== "kind" && k !== "tag" && k !== "children");
      expect(keys, element.tag).toEqual(element.tag === "a" ? ["href"] : []);
    }
    expect(JSON.stringify(nodes)).not.toContain("steal");
  });

  it("renders an escaped tag as the characters it is, not as a tag", () => {
    const nodes = parse("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(textOf(nodes)).toBe("<script>alert(1)</script>");
    expect(elementsOf(nodes).map((e) => e.tag)).toEqual(["block"]);
  });

  it("only ever emits tags from the whitelist", () => {
    const raw =
      '<form action="x"><input value="y"><iframe src="//evil.test"></iframe><object></object>' +
      "<marquee>hi</marquee><h1>Head</h1><blockquote>quote</blockquote><pre>code</pre></form>";
    const allowed = new Set(["block", "ul", "ol", "li", "b", "i", "u", "s", "code", "a"]);
    for (const element of elementsOf(parse(raw))) expect(allowed.has(element.tag), element.tag).toBe(true);
    expect(textOf(parse(raw))).toContain("hi");
    expect(textOf(parse(raw))).not.toContain("evil.test");
  });

  it("flattens absurd nesting instead of building a tree that deep", () => {
    const deep = "<b>".repeat(400) + "still here" + "</b>".repeat(400);
    const nodes = parse(deep);
    expect(textOf(nodes)).toBe("still here");
    const depth = (list: readonly DescNode[]): number =>
      1 + Math.max(0, ...list.map((n) => (n.kind === "element" ? depth(n.children) : 0)));
    expect(depth(nodes)).toBeLessThanOrEqual(20);
  });

  it("drops a tag that never terminates rather than spilling it as words", () => {
    expect(textOf(parse('<b>bold</b><a href="https://ok.test' + "x".repeat(200)))).toBe("bold");
    expect(textOf(parse("<<<<>>>>text"))).toContain("text");
  });
});
