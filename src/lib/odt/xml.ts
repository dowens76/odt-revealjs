export const NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
  xlink: 'http://www.w3.org/1999/xlink',
  svg: 'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0',
  math: 'http://www.w3.org/1998/Math/MathML',
} as const;

export type NsKey = keyof typeof NS;

export function parseXml(source: string): Document {
  const doc = new DOMParser().parseFromString(source, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error(`Invalid XML: ${err.textContent?.slice(0, 200)}`);
  return doc;
}

export function is(node: Node | null | undefined, ns: NsKey, local: string): boolean {
  return !!node && node.nodeType === 1 && (node as Element).namespaceURI === NS[ns] && (node as Element).localName === local;
}

export function attr(el: Element, ns: NsKey, local: string): string | null {
  return el.getAttributeNS(NS[ns], local);
}

export function childElements(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as Element);
  return out;
}

export function firstChild(el: Element, ns: NsKey, local: string): Element | null {
  for (let n = el.firstChild; n; n = n.nextSibling) if (is(n, ns, local)) return n as Element;
  return null;
}

export function children(el: Element, ns: NsKey, local: string): Element[] {
  return childElements(el).filter((c) => is(c, ns, local));
}

export function descendants(root: Element | Document, ns: NsKey, local: string): Element[] {
  return Array.from(root.getElementsByTagNameNS(NS[ns], local));
}

/** Convert an ODF length ("2.5cm", "1in", "12pt", "40mm", "300px") to CSS pixels at 96 dpi. */
export function lengthToPx(value: string | null): number | null {
  if (!value) return null;
  const m = /^\s*(-?[\d.]+)\s*(cm|mm|in|pt|pc|px)?\s*$/i.exec(value);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const factor: Record<string, number> = { cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pt: 96 / 72, pc: 16, px: 1 };
  return Math.round(n * factor[(m[2] ?? 'px').toLowerCase()]);
}

/** Decode ODF style-name escaping: "Text_20_body" → "Text body". */
export function decodeStyleName(name: string): string {
  return name.replace(/_([0-9a-fA-F]{2,4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
