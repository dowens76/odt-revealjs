import { unzipSync, strFromU8 } from 'fflate';
import type { Block, ImageAsset, Inline, ListItem, OdtDocument, Section, StyleUsage, TableCell } from '../model';
import { base64ToBytes, isBrowserImage, sniffImageMime } from './images';
import { StyleRegistry } from './styles';
import { attr, childElements, children, descendants, firstChild, is, lengthToPx, NS, parseXml } from './xml';

export const DEFAULT_PARAGRAPH_STYLE = 'Default Paragraph Style';

const SKIPPED_INLINE = new Set([
  'bookmark', 'bookmark-start', 'bookmark-end', 'reference-mark', 'reference-mark-start', 'reference-mark-end',
  'soft-page-break', 'change', 'change-start', 'change-end', 'alphabetical-index-mark', 'alphabetical-index-mark-start',
  'alphabetical-index-mark-end', 'toc-mark', 'toc-mark-start', 'toc-mark-end', 'user-index-mark',
  'user-index-mark-start', 'user-index-mark-end', 'note-citation',
]);

const INDEX_ELEMENTS = new Set([
  'table-of-content', 'illustration-index', 'table-index', 'object-index', 'user-index', 'alphabetical-index', 'bibliography',
]);

/** Parse an .odt (zip) or .fodt (flat XML) file. */
export function parseOdt(bytes: Uint8Array): OdtDocument {
  return new OdtParser(bytes).parse();
}

class OdtParser {
  private files: Record<string, Uint8Array> = {};
  private registry = new StyleRegistry();
  private images = new Map<string, ImageAsset>();
  private imageByPath = new Map<string, string>();
  private warnings = new Set<string>();
  private paraUsage = new Map<string, StyleUsage>();
  private textUsage = new Map<string, StyleUsage>();
  private headingUsage = new Map<string, StyleUsage>();
  private sections: Section[] = [];
  private current!: Section;
  private usedIds = new Set<string>();
  private body!: Element;
  private metaTitle = '';
  private skippedShapes = 0;

  constructor(bytes: Uint8Array) {
    const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    if (isZip) {
      this.files = unzipSync(bytes);
      const mimetype = this.files['mimetype'] ? strFromU8(this.files['mimetype']).trim() : '';
      if (mimetype && !mimetype.startsWith('application/vnd.oasis.opendocument.text')) {
        throw new Error(`Not an OpenDocument text file (mimetype: ${mimetype}).`);
      }
      const content = this.files['content.xml'];
      if (!content) throw new Error('The file has no content.xml — is it really an .odt document?');
      if (this.files['styles.xml']) this.registry.add(parseXml(strFromU8(this.files['styles.xml'])), false);
      const contentDoc = parseXml(strFromU8(content));
      this.registry.add(contentDoc, false);
      this.body = this.findBody(contentDoc);
      if (this.files['meta.xml']) this.metaTitle = this.readMetaTitle(parseXml(strFromU8(this.files['meta.xml'])));
    } else {
      const doc = parseXml(new TextDecoder().decode(bytes));
      this.registry.add(doc, false);
      this.body = this.findBody(doc);
      this.metaTitle = this.readMetaTitle(doc);
    }
  }

  private findBody(doc: Document): Element {
    const text = descendants(doc, 'office', 'text')[0];
    if (!text) throw new Error('No text body found — only text documents (.odt/.fodt) are supported.');
    return text;
  }

  private readMetaTitle(doc: Document): string {
    return doc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0]?.textContent?.trim() ?? '';
  }

  parse(): OdtDocument {
    this.current = this.newSection(0, '', [], null);
    this.walkBody(this.body);
    const sections = this.sections.filter((s) => s.level > 0 || s.blocks.length > 0);
    if (this.skippedShapes) this.warnings.add(`${this.skippedShapes} drawing shape(s) (lines, arrows, shape groups) are not supported and were skipped.`);
    const firstTitle = this.findTitleParagraph(sections);
    return {
      title: this.metaTitle || firstTitle || sections.find((s) => s.level > 0)?.title || '',
      sections,
      paragraphStyles: sortUsage(this.paraUsage),
      textStyles: sortUsage(this.textUsage),
      headingStyles: sortUsage(this.headingUsage),
      images: this.images,
      warnings: [...this.warnings],
    };
  }

  private findTitleParagraph(sections: Section[]): string {
    const pre = sections[0]?.level === 0 ? sections[0] : null;
    const b = pre?.blocks.find((b) => b.kind === 'para' && b.style === 'Title');
    return b && b.kind === 'para' ? plainText(b.inlines) : '';
  }

  // ---------- structure ----------

  private newSection(level: number, title: string, heading: Inline[], headingStyle: string | null): Section {
    const base = slugify(title) || (level === 0 ? 'intro' : 'section');
    let id = base;
    for (let n = 2; this.usedIds.has(id); n++) id = `${base}-${n}`;
    this.usedIds.add(id);
    const s: Section = { id, level, title, heading, headingStyle, blocks: [] };
    this.sections.push(s);
    return s;
  }

  private walkBody(el: Element) {
    for (const child of childElements(el)) {
      if (is(child, 'text', 'h')) {
        const style = this.registry.logicalName('paragraph', attr(child, 'text', 'style-name')) ?? 'Heading';
        const heading = this.inlines(child);
        const title = plainText(heading).trim();
        const level = Math.max(1, parseInt(attr(child, 'text', 'outline-level') ?? '1', 10) || 1);
        count(this.headingUsage, style, title);
        this.current = this.newSection(level, title, heading, style);
      } else if (is(child, 'text', 'list') && descendants(child, 'text', 'h').length > 0) {
        // Numbered headings are sometimes wrapped in lists (e.g. documents converted from Word).
        for (const item of childElements(child)) this.walkBody(item);
      } else if (is(child, 'text', 'section') || is(child, 'text', 'list-item') || is(child, 'text', 'list-header')) {
        this.walkBody(child);
      } else if (child.namespaceURI === NS.text && INDEX_ELEMENTS.has(child.localName)) {
        this.warnings.add('Tables of contents and indexes were skipped.');
      } else if (is(child, 'draw', 'frame') || is(child, 'draw', 'a')) {
        const inlines = this.inlineNode(child);
        if (inlines.length) this.current.blocks.push({ kind: 'para', style: DEFAULT_PARAGRAPH_STYLE, inlines });
      } else {
        const block = this.block(child, null, 1);
        if (block) this.current.blocks.push(block);
        else if (child.namespaceURI === NS.draw) this.skippedShapes++;
      }
    }
  }

  private block(el: Element, listStyle: string | null, listLevel: number): Block | null {
    if (is(el, 'text', 'p') || is(el, 'text', 'h')) {
      const style = this.registry.logicalName('paragraph', attr(el, 'text', 'style-name')) ?? DEFAULT_PARAGRAPH_STYLE;
      const inlines = this.inlines(el);
      count(this.paraUsage, style, plainText(inlines));
      return { kind: 'para', style, inlines };
    }
    if (is(el, 'text', 'list')) return this.list(el, listStyle, listLevel);
    if (is(el, 'table', 'table')) return this.table(el);
    return null;
  }

  private blocks(el: Element, listStyle: string | null = null, listLevel = 1): Block[] {
    const out: Block[] = [];
    for (const child of childElements(el)) {
      if (is(child, 'text', 'section')) out.push(...this.blocks(child, listStyle, listLevel));
      else {
        const b = this.block(child, listStyle, listLevel);
        if (b) out.push(b);
      }
    }
    return out;
  }

  private list(el: Element, inherited: string | null, level: number): Block {
    let listStyle = attr(el, 'text', 'style-name') ?? inherited;
    const items: ListItem[] = [];
    let start: number | null = null;
    for (const item of childElements(el)) {
      if (!is(item, 'text', 'list-item') && !is(item, 'text', 'list-header')) continue;
      if (items.length === 0) {
        const sv = attr(item, 'text', 'start-value');
        if (sv) start = parseInt(sv, 10);
        if (!listStyle) {
          const p = firstChild(item, 'text', 'p') ?? firstChild(item, 'text', 'h');
          if (p) listStyle = this.registry.paragraphListStyle(attr(p, 'text', 'style-name'));
        }
      }
      items.push({ blocks: this.blocks(item, listStyle, level + 1) });
    }
    return { kind: 'list', ordered: this.registry.isOrderedList(listStyle, level), start, items };
  }

  private table(el: Element): Block {
    const rows: TableCell[][] = [];
    const addRows = (container: Element, header: boolean) => {
      for (const child of childElements(container)) {
        if (is(child, 'table', 'table-header-rows')) addRows(child, true);
        else if (is(child, 'table', 'table-rows') || is(child, 'table', 'table-row-group')) addRows(child, header);
        else if (is(child, 'table', 'table-row')) {
          const row: TableCell[] = [];
          for (const cell of children(child, 'table', 'table-cell')) {
            const blocks = this.blocks(cell);
            const repeat = Math.min(parseInt(attr(cell, 'table', 'number-columns-repeated') ?? '1', 10) || 1, 64);
            for (let i = 0; i < repeat; i++) {
              row.push({
                blocks,
                header,
                colSpan: parseInt(attr(cell, 'table', 'number-columns-spanned') ?? '1', 10) || 1,
                rowSpan: parseInt(attr(cell, 'table', 'number-rows-spanned') ?? '1', 10) || 1,
              });
            }
          }
          // Drop trailing empty padding cells that spreadsheets-in-docs often carry.
          while (row.length > 1 && row[row.length - 1].blocks.length === 0) row.pop();
          rows.push(row);
        }
      }
    };
    addRows(el, false);
    return { kind: 'table', rows };
  }

  // ---------- inline content ----------

  private inlines(el: Element): Inline[] {
    const out: Inline[] = [];
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        const text = (n.nodeValue ?? '').replace(/[ \t\r\n]+/g, ' ');
        if (text) out.push({ kind: 'text', text });
      } else if (n.nodeType === 1) {
        out.push(...this.inlineNode(n as Element));
      }
    }
    return out;
  }

  private inlineNode(el: Element): Inline[] {
    const ns = el.namespaceURI;
    const name = el.localName;
    if (ns === NS.text) {
      if (SKIPPED_INLINE.has(name)) return [];
      switch (name) {
        case 's': {
          const c = parseInt(attr(el, 'text', 'c') ?? '1', 10) || 1;
          return [{ kind: 'text', text: ' '.repeat(c) }];
        }
        case 'tab':
          return [{ kind: 'text', text: ' ' }];
        case 'line-break':
          return [{ kind: 'break' }];
        case 'span': {
          const styleName = attr(el, 'text', 'style-name');
          const style = this.registry.logicalName('text', styleName);
          const childInlines = this.inlines(el);
          if (style) count(this.textUsage, style, plainText(childInlines));
          return [{ kind: 'span', style, ...this.registry.textFormats(styleName), children: childInlines }];
        }
        case 'a':
          return [{ kind: 'link', href: attr(el, 'xlink', 'href') ?? '', children: this.inlines(el) }];
        case 'note': {
          const body = firstChild(el, 'text', 'note-body');
          const noteClass = attr(el, 'text', 'note-class') === 'endnote' ? 'endnote' : 'footnote';
          return [{ kind: 'note', noteClass, blocks: body ? this.blocks(body) : [] }];
        }
        case 'ruby': {
          const base = firstChild(el, 'text', 'ruby-base');
          return base ? this.inlines(base) : [];
        }
        default:
          // Fields (page number, date, sequence, cross-references, …): keep their displayed text.
          return this.inlines(el);
      }
    }
    if (ns === NS.office && (name === 'annotation' || name === 'annotation-end')) return [];
    if (ns === NS.draw) {
      if (name === 'frame') return this.frame(el);
      if (name === 'a') return this.inlines(el);
      this.skippedShapes++;
      return [];
    }
    return this.inlines(el);
  }

  private frame(el: Element): Inline[] {
    const widthPx = lengthToPx(attr(el, 'svg', 'width'));
    const heightPx = lengthToPx(attr(el, 'svg', 'height'));
    const alt = (firstChild(el, 'svg', 'title')?.textContent || firstChild(el, 'svg', 'desc')?.textContent || '').trim();

    const textBox = firstChild(el, 'draw', 'text-box');
    if (textBox) {
      // Typically an image with a caption: flatten its paragraphs, separated by line breaks.
      const out: Inline[] = [];
      for (const b of this.blocks(textBox)) {
        if (b.kind !== 'para') continue;
        if (out.length) out.push({ kind: 'break' });
        out.push(...b.inlines);
      }
      return out;
    }

    const obj = firstChild(el, 'draw', 'object') ?? firstChild(el, 'draw', 'object-ole');
    if (obj) {
      const math = this.mathFromObject(obj);
      if (math) return [{ kind: 'math', mathml: math }];
    }

    const candidates = children(el, 'draw', 'image')
      .map((img) => this.registerImage(img))
      .filter((a): a is ImageAsset => !!a);
    const chosen = candidates.find((a) => a.supported) ?? candidates[0];
    if (!chosen) {
      if (obj) this.warnings.add('Embedded objects (charts, spreadsheets) without a preview image were skipped.');
      return [];
    }
    if (!chosen.supported) {
      const kind = chosen.mime.replace(/^image\/(x-)?/, '').toUpperCase();
      this.warnings.add(
        obj
          ? `An embedded object (chart/OLE) only has a ${kind} preview, which browsers cannot display — it was skipped.`
          : `Image "${chosen.path}" is ${kind}, which browsers cannot display — it was skipped. Re-save it as PNG/SVG in the document.`,
      );
    }
    return [{ kind: 'image', imageId: chosen.id, widthPx, heightPx, alt }];
  }

  private mathFromObject(obj: Element): string | null {
    const inline = obj.getElementsByTagNameNS(NS.math, 'math')[0];
    if (inline) return serializeMath(inline);
    const href = (attr(obj, 'xlink', 'href') ?? '').replace(/^\.\//, '').replace(/\/$/, '');
    const data = href && this.files[`${href}/content.xml`];
    if (!data) return null;
    try {
      const doc = parseXml(strFromU8(data));
      const root = doc.documentElement;
      if (root.namespaceURI !== NS.math || root.localName !== 'math') return null;
      return serializeMath(root);
    } catch {
      return null;
    }
  }

  private registerImage(img: Element): ImageAsset | null {
    const href = attr(img, 'xlink', 'href') ?? '';
    const binary = firstChild(img, 'office', 'binary-data');
    const key = href || `binary:${this.images.size}`;
    const existing = this.imageByPath.get(key);
    if (existing) return this.images.get(existing)!;

    let data: Uint8Array | null = null;
    let linked = false;
    if (binary?.textContent) data = base64ToBytes(binary.textContent);
    else if (href) {
      data = this.files[href.replace(/^\.\//, '')] ?? null;
      linked = !data;
    } else return null;

    const mime = sniffImageMime(data, href);
    const isWeb = /^https?:\/\//i.test(href);
    if (linked && !isWeb) {
      this.warnings.add(`Image "${href}" is linked (not embedded) in the document and could not be included.`);
    }
    const asset: ImageAsset = {
      id: `img${this.images.size + 1}`,
      path: href || '(embedded)',
      mime,
      data,
      supported: isBrowserImage(mime) && (!linked || isWeb),
      linked,
    };
    this.images.set(asset.id, asset);
    this.imageByPath.set(key, asset.id);
    return asset;
  }
}

// ---------- helpers ----------

const MATH_ELEMENTS = new Set([
  'math', 'semantics', 'mrow', 'mi', 'mn', 'mo', 'mtext', 'mspace', 'ms', 'mfrac', 'msqrt', 'mroot', 'mstyle', 'merror',
  'mpadded', 'mphantom', 'mfenced', 'menclose', 'msub', 'msup', 'msubsup', 'munder', 'mover', 'munderover',
  'mmultiscripts', 'mprescripts', 'none', 'mtable', 'mtr', 'mlabeledtr', 'mtd', 'maligngroup', 'malignmark',
]);
const MATH_ATTRS = /^(display|mathvariant|mathsize|mathcolor|mathbackground|stretchy|fence|separator|lspace|rspace|largeop|movablelimits|accent|accentunder|form|linethickness|bevelled|notation|columnalign|rowalign|columnspacing|rowspacing|columnlines|rowlines|frame|width|height|depth|open|close|separators|scriptlevel|displaystyle|symmetric|maxsize|minsize|align|rowspan|columnspan)$/;

/**
 * Re-emit MathML from an allowlist of elements and attributes. Formulas come from the
 * document, so this keeps scripts and event handlers in a crafted file out of the output.
 * It also drops namespace prefixes and the StarMath source annotation.
 */
function serializeMath(el: Element): string {
  const walk = (node: Node): string => {
    if (node.nodeType === 3) return escText(node.nodeValue ?? '');
    if (node.nodeType !== 1) return '';
    const e = node as Element;
    if (e.namespaceURI !== NS.math || !MATH_ELEMENTS.has(e.localName)) return '';
    const attrs = Array.from(e.attributes)
      .filter((a) => !a.prefix && MATH_ATTRS.test(a.localName))
      .map((a) => ` ${a.localName}="${escText(a.value).replace(/"/g, '&quot;')}"`)
      .join('');
    const xmlns = e.localName === 'math' ? ` xmlns="${NS.math}"` : '';
    return `<${e.localName}${xmlns}${attrs}>${Array.from(e.childNodes).map(walk).join('')}</${e.localName}>`;
  };
  return walk(el);
}

function escText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function plainText(inlines: Inline[]): string {
  let s = '';
  for (const i of inlines) {
    if (i.kind === 'text') s += i.text;
    else if (i.kind === 'break') s += ' ';
    else if (i.kind === 'span' || i.kind === 'link') s += plainText(i.children);
  }
  return s.replace(/ /g, ' ');
}

function count(map: Map<string, StyleUsage>, name: string, text: string) {
  const u = map.get(name);
  const sample = text.trim().replace(/\s+/g, ' ').slice(0, 90);
  if (u) {
    u.count++;
    if (!u.sample && sample) u.sample = sample;
  } else map.set(name, { name, count: 1, sample });
}

function sortUsage(map: Map<string, StyleUsage>): StyleUsage[] {
  return [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function slugify(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
