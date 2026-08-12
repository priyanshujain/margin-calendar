// Google Calendar descriptions are HTML. Not "sometimes HTML": the API documents the field as
// HTML, and a real account returns `<br>`, `<a href>`, `<b>`, lists, and the `pastedDriveLink`
// anchors the web UI writes when you paste a Docs URL. Printing that field as text puts raw markup
// in front of the user, which is the bug this module exists to fix.
//
// It is also the least trustworthy string in the app. Anyone who can put an event on a calendar
// you subscribe to writes those bytes, so it can never reach `dangerouslySetInnerHTML`. Instead the
// markup is parsed here into a small tree of plain data, and the card turns that tree into React
// elements. Nothing that is not in `TAGS` survives, no attribute other than a vetted `href`
// survives, and `<script>` and `<style>` are swallowed whole, so there is no path from the wire to
// executable anything.
//
// The parser is deliberately hand-written rather than `DOMParser`: it is pure, so the unit run in
// node covers it, including the hostile cases, and it cannot be tempted into loading a subresource
// the way a real document fragment can.
//
// A description may equally be plain text with newlines in it. `parseDescription` decides which it
// is looking at and says so, because the two want different whitespace treatment: HTML collapses
// its own, plain text has meaningful indentation.

/** The entire vocabulary the card will render. Everything else degrades to its text. */
export type DescTag = "block" | "ul" | "ol" | "li" | "b" | "i" | "u" | "s" | "code" | "a";

export interface DescText {
  kind: "text";
  text: string;
}

export interface DescBreak {
  kind: "break";
}

export interface DescElement {
  kind: "element";
  tag: DescTag;
  /** Only ever set on `a`, only ever an http, https or mailto URL. */
  href?: string;
  children: DescNode[];
}

export type DescNode = DescText | DescBreak | DescElement;

export interface Description {
  /** True when the source carried no markup, so its own spacing is worth preserving. */
  plain: boolean;
  nodes: DescNode[];
}

/** Source names mapped onto the small vocabulary above. Anything absent here is not rendered. */
const TAGS = new Map<string, DescTag>([
  ["a", "a"],
  ["b", "b"],
  ["strong", "b"],
  ["i", "i"],
  ["em", "i"],
  ["cite", "i"],
  ["u", "u"],
  ["ins", "u"],
  ["s", "s"],
  ["strike", "s"],
  ["del", "s"],
  ["code", "code"],
  ["kbd", "code"],
  ["samp", "code"],
  ["tt", "code"],
  ["p", "block"],
  ["div", "block"],
  ["pre", "block"],
  ["blockquote", "block"],
  ["h1", "block"],
  ["h2", "block"],
  ["h3", "block"],
  ["h4", "block"],
  ["h5", "block"],
  ["h6", "block"],
  ["ul", "ul"],
  ["ol", "ol"],
  ["li", "li"],
]);

/** Elements whose content is text to the tokenizer, and which are dropped along with it. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "noscript", "iframe", "xmp"]);

/** No end tag, so they must never open a frame. `br` is handled before this set is consulted. */
const VOID = new Set([
  "area",
  "base",
  "basefont",
  "br",
  "col",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/**
 * Past this the tree is nested deeper than any description means anything at, and the extra levels
 * are flattened. `<b><b><b>` a thousand deep is a cheap way to make a renderer work hard.
 */
const MAX_DEPTH = 16;

/** Only these three. A `javascript:` or `data:` URL is not a link, it is an attack. */
const SAFE_SCHEME = /^(?:https?:|mailto:)/i;

/** Control characters and the invisible spaces, none of which belong inside a URL. */
const INVISIBLE = /[\u0000-\u0020\u007f-\u00a0\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g;

const MARKUP = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/y;
const ATTRIBUTE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;
const ENTITY = /&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g;

/**
 * A complete tag, or the start of a comment. What decides that a description is markup rather than
 * prose that happens to contain an angle bracket, which is why it wants a closing `>` and not just
 * something that starts hopefully.
 */
const HAS_TAG = /<(?:\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^<>]*)?\/?>|!--)/;

// A Map rather than an object literal, so that `&constructor;` cannot walk into Object.prototype
// and hand a function back to the replacer. Escapes rather than the characters themselves, because
// half of these are indistinguishable from a plain space or hyphen in a source file.
const NAMED = new Map<string, string>([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", "\u00a0"],
  ["ensp", "\u2002"],
  ["emsp", "\u2003"],
  ["thinsp", "\u2009"],
  ["shy", ""],
  ["hellip", "…"],
  ["mdash", "\u2014"],
  ["ndash", "\u2013"],
  ["lsquo", "‘"],
  ["rsquo", "’"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["bull", "•"],
  ["middot", "·"],
  ["laquo", "«"],
  ["raquo", "»"],
  ["copy", "©"],
  ["reg", "®"],
  ["trade", "™"],
  ["deg", "°"],
  ["plusmn", "±"],
  ["times", "×"],
  ["divide", "÷"],
  ["frac12", "½"],
  ["frac14", "¼"],
  ["euro", "€"],
  ["pound", "£"],
  ["yen", "¥"],
  ["cent", "¢"],
  ["sect", "§"],
  ["para", "¶"],
  ["dagger", "†"],
  ["prime", "′"],
  ["ne", "≠"],
  ["le", "≤"],
  ["ge", "≥"],
  ["larr", "←"],
  ["rarr", "→"],
  ["harr", "↔"],
]);

/** True when the string contains something tag-shaped, which is what makes it worth parsing. */
export function hasMarkup(text: string): boolean {
  return HAS_TAG.test(text);
}

/**
 * Character references, named and numeric. Anything unrecognised is left exactly as it was found,
 * which is both what a browser does and the safe direction to fail in: an undecoded `&#38;` is a
 * cosmetic wart, an over-eager decode is a way to smuggle a delimiter past a check.
 */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const value = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      return codePoint(value) ?? whole;
    }
    return NAMED.get(body) ?? NAMED.get(body.toLowerCase()) ?? whole;
  });
}

/** Surrogates, out-of-range values and control characters never come back as text. */
function codePoint(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return null;
  if (value >= 0xd800 && value <= 0xdfff) return null;
  if (value < 0x20 && value !== 0x09 && value !== 0x0a) return null;
  return String.fromCodePoint(value);
}

/**
 * The URL of a link, or null if it is not one we will follow.
 *
 * A whitelist of schemes, checked after decoding, because `&#106;avascript:` and a tab wedged into
 * the middle of the word are both older than this app. Since the test is "does it begin with one
 * of three known schemes" rather than "is it one of the bad ones", obfuscation has nothing to win:
 * anything it produces that is not plainly http, https or mailto is dropped.
 */
export function safeHref(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = decodeEntities(raw).replace(INVISIBLE, "");
  if (!cleaned || !SAFE_SCHEME.test(cleaned)) return null;
  return cleaned;
}

/** What the card should render for a description, whichever of the two shapes it arrived in. */
export function parseDescription(raw: string | null | undefined): Description {
  const source = raw ?? "";
  if (!source.trim()) return { plain: true, nodes: [] };
  if (!hasMarkup(source)) return { plain: true, nodes: tidy(plainNodes(source), null) };
  return { plain: false, nodes: tidy(htmlNodes(source), null) };
}

/** Plain text: the newlines are the whole structure, and everything else is left alone. */
function plainNodes(text: string): DescNode[] {
  const decoded = decodeEntities(text);
  const out: DescNode[] = [];
  decoded.split(/\r\n|\r|\n/).forEach((line, index) => {
    if (index > 0) out.push({ kind: "break" });
    if (line) out.push({ kind: "text", text: line });
  });
  return out;
}

interface Frame {
  /** The source name, which is what a closing tag is matched against. */
  name: string;
  /** null means transparent: the element is not rendered and its children join its parent. */
  tag: DescTag | null;
  href?: string;
  children: DescNode[];
}

/**
 * A stack machine over the token stream. Unknown elements become transparent frames rather than
 * being dropped with their contents, which is what makes `<span>`, `<font>` and a pasted table
 * degrade to the words they contained. Unclosed tags close themselves at the end, stray closing
 * tags are ignored, and a closing tag that matches something further down the stack closes
 * everything above it, so no input can leave the tree unbalanced.
 */
function htmlNodes(html: string): DescNode[] {
  const root: Frame = { name: "", tag: null, children: [] };
  const stack: Frame[] = [root];
  const top = (): Frame => stack[stack.length - 1];

  const closeTop = (): void => {
    if (stack.length < 2) return;
    const frame = stack.pop() as Frame;
    const parent = top();
    if (frame.tag === null) parent.children.push(...frame.children);
    else if (frame.tag === "a") {
      parent.children.push({ kind: "element", tag: "a", href: frame.href, children: frame.children });
    } else parent.children.push({ kind: "element", tag: frame.tag, children: frame.children });
  };

  const addText = (chunk: string): void => {
    // HTML's own whitespace rules: a run of it is one space. `&nbsp;` survives because it is
    // decoded after the collapse, which is the difference between a space and a hard space.
    const text = decodeEntities(chunk.replace(/[\t\n\f\r ]+/g, " "));
    if (text) top().children.push({ kind: "text", text });
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      addText(html.slice(i));
      break;
    }
    if (lt > i) addText(html.slice(i, lt));

    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html.startsWith("<!", lt) || html.startsWith("<?", lt)) {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }

    MARKUP.lastIndex = lt;
    const tag = MARKUP.exec(html);
    if (!tag) {
      // Something tag-shaped that never finished parsing: a browser drops it, and so do we, rather
      // than spilling half an attribute list into the card as words. A bare `<` in prose, which is
      // the far more common case, is text and stays text.
      if (/^<\/?[a-zA-Z]/.test(html.slice(lt, lt + 3))) {
        const end = html.indexOf(">", lt);
        i = end < 0 ? html.length : end + 1;
      } else {
        addText("<");
        i = lt + 1;
      }
      continue;
    }
    i = MARKUP.lastIndex;

    const name = tag[2].toLowerCase();
    const attrs = tag[3] ?? "";

    if (tag[1] === "/") {
      for (let at = stack.length - 1; at > 0; at -= 1) {
        if (stack[at].name !== name) continue;
        while (stack.length > at) closeTop();
        break;
      }
      continue;
    }

    if (RAW_TEXT.has(name)) {
      // Everything up to the matching close is the element's raw text, and none of it is ours.
      // An unterminated one swallows the rest of the description, which is what a browser does.
      const close = new RegExp(`</\\s*${name}(?:\\s[^>]*)?>`, "i");
      const found = close.exec(html.slice(i));
      i = found ? i + found.index + found[0].length : html.length;
      continue;
    }

    if (name === "br") {
      top().children.push({ kind: "break" });
      continue;
    }
    if (VOID.has(name)) continue;

    // `<li>a<li>b` is two items, not one nested inside the other.
    if (name === "li" && top().name === "li") closeTop();

    let mapped = stack.length > MAX_DEPTH ? null : TAGS.get(name) ?? null;
    let href: string | undefined;
    if (mapped === "a") {
      href = safeHref(attribute(attrs, "href")) ?? undefined;
      // A link we will not follow is not a link. Its text still belongs to the reader.
      if (!href) mapped = null;
    }

    stack.push({ name, tag: mapped, href, children: [] });
    if (/\/\s*$/.test(attrs)) closeTop();
  }

  while (stack.length > 1) closeTop();
  return root.children;
}

/** One attribute out of a tag's attribute text. Every other attribute is discarded unread. */
function attribute(attrs: string, want: string): string | null {
  ATTRIBUTE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(attrs)) !== null) {
    if (match[1].toLowerCase() !== want) continue;
    const value = match[2];
    if (value === undefined) return null;
    const quoted = value.startsWith('"') || value.startsWith("'");
    return quoted ? value.slice(1, -1) : value;
  }
  return null;
}

const isBreak = (node: DescNode): boolean => node.kind === "break";

const isBlank = (node: DescNode): boolean =>
  isBreak(node) || (node.kind === "text" && node.text.trim() === "");

/**
 * The cosmetic pass. Descriptions arrive padded with the editor's leftovers: empty paragraphs, a
 * run of six `<br>` at the end, list markup with loose text in it. None of that should turn into
 * white space the reader has to scroll past.
 */
function tidy(nodes: readonly DescNode[], parent: DescTag | null): DescNode[] {
  const out: DescNode[] = [];

  for (const node of nodes) {
    if (node.kind === "text") {
      out.push(node);
      continue;
    }
    if (node.kind === "break") {
      // Two is a blank line. Beyond that it is someone leaning on the return key.
      const run = out.length >= 2 && isBreak(out[out.length - 1]) && isBreak(out[out.length - 2]);
      if (!run) out.push(node);
      continue;
    }

    // An `<li>` that lost its list reads as a paragraph rather than as a stray bullet.
    const tag = node.tag === "li" && parent !== "ul" && parent !== "ol" ? "block" : node.tag;
    let children = tidy(node.children, tag);
    if (tag === "ul" || tag === "ol") children = intoItems(children);
    if (children.length === 0) continue;
    out.push(
      node.href
        ? { kind: "element", tag, href: node.href, children }
        : { kind: "element", tag, children },
    );
  }

  return trimEdges(out);
}

/** Loose content directly inside a list is gathered into items, so `ul` only ever holds `li`. */
function intoItems(children: readonly DescNode[]): DescNode[] {
  const items: DescNode[] = [];
  let loose: DescNode[] = [];
  const flush = (): void => {
    const trimmed = trimEdges(loose);
    if (trimmed.length > 0) items.push({ kind: "element", tag: "li", children: trimmed });
    loose = [];
  };
  for (const child of children) {
    if (child.kind === "element" && child.tag === "li") {
      flush();
      items.push(child);
    } else loose.push(child);
  }
  flush();
  return items;
}

/** Blank leading and trailing nodes go, and the text at either end loses its outer whitespace. */
function trimEdges(nodes: readonly DescNode[]): DescNode[] {
  let from = 0;
  let to = nodes.length;
  while (from < to && isBlank(nodes[from])) from += 1;
  while (to > from && isBlank(nodes[to - 1])) to -= 1;
  const out = nodes.slice(from, to);
  if (out.length === 0) return [];

  const first = out[0];
  if (first.kind === "text") out[0] = { kind: "text", text: first.text.replace(/^[ \t]+/, "") };
  const last = out[out.length - 1];
  if (last.kind === "text") out[out.length - 1] = { kind: "text", text: last.text.replace(/[ \t]+$/, "") };
  return out.filter((node) => node.kind !== "text" || node.text !== "");
}
