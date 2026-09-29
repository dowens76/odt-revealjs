import type { Block, ImageAsset, Inline, OdtDocument, Section, TextFormat } from './model';
import { slugify } from './odt/parse';

export type ParagraphAction = 'include' | 'exclude' | 'notes';
export type TextAction = 'include' | 'plain' | 'exclude';
export type FootnoteMode = 'notes' | 'slide' | 'drop';

export interface ConversionSettings {
  /** Section id → included. Missing ids are included. */
  sections: Record<string, boolean>;
  /** Paragraph style name → action. Missing styles are included. */
  paragraphStyles: Record<string, ParagraphAction>;
  /** Character style name → action. Missing styles are included. */
  textStyles: Record<string, TextAction>;
  /** Keep bold/italic/etc. applied directly in the editor (not via a named style). */
  directFormatting: boolean;
  images: boolean;
  footnotes: FootnoteMode;
  /** "vertical" nests lower-level headings under the top level as reveal.js vertical slides. */
  nesting: 'flat' | 'vertical';
  /** Add class="odt-<style-name>" to elements so ODT styles can be targeted with CSS. */
  styleClasses: boolean;
}

export const DEFAULT_SETTINGS: ConversionSettings = {
  sections: {},
  paragraphStyles: {},
  textStyles: {},
  directFormatting: true,
  images: true,
  footnotes: 'notes',
  nesting: 'flat',
  styleClasses: false,
};

export interface RenderOptions {
  /** Returns the src for an image, or null to omit it. */
  imageSrc: (asset: ImageAsset) => string | null;
}

const PRE_STYLES = /^(preformatted text|source code|code|code block)$/i;
const QUOTE_STYLES = /^(quotations?|quote|block ?quote|intense quote)$/i;

export function includedSections(doc: OdtDocument, settings: ConversionSettings): Section[] {
  return doc.sections.filter((s) => settings.sections[s.id] !== false);
}

/** Render the selected sections of a document as reveal.js `<section>` markup. */
export function renderSections(doc: OdtDocument, settings: ConversionSettings, options: RenderOptions): string {
  const r = new Renderer(doc, settings, options);
  const sections = includedSections(doc, settings);
  if (settings.nesting === 'flat') return sections.map((s) => r.section(s, '')).join('\n\n');

  const headingLevels = sections.filter((s) => s.level > 0).map((s) => s.level);
  const top = headingLevels.length ? Math.min(...headingLevels) : 1;
  const groups: Section[][] = [];
  for (const s of sections) {
    if (s.level <= top || groups.length === 0) groups.push([s]);
    else groups[groups.length - 1].push(s);
  }
  return groups
    .map((g) =>
      g.length === 1 ? r.section(g[0], '') : `<section>\n${g.map((s) => r.section(s, '  ')).join('\n\n')}\n</section>`,
    )
    .join('\n\n');
}

class Renderer {
  private notes: string[] = [];
  private footnotes: string[] = [];

  constructor(
    private doc: OdtDocument,
    private settings: ConversionSettings,
    private options: RenderOptions,
  ) {}

  section(s: Section, indent: string): string {
    this.notes = [];
    this.footnotes = [];
    const parts: string[] = [];
    if (s.level > 0) {
      const tag = `h${Math.min(s.level, 6)}`;
      parts.push(`<${tag}${this.cls(s.headingStyle)}>${this.inlines(s.heading).trim()}</${tag}>`);
    }
    parts.push(...this.blocks(s.blocks));
    if (this.footnotes.length) {
      parts.push(`<ol class="footnotes">\n${this.footnotes.map((f) => `  <li>${f}</li>`).join('\n')}\n</ol>`);
    }
    if (this.notes.length) {
      parts.push(`<aside class="notes">\n${this.notes.map((n) => `  ${n}`).join('\n')}\n</aside>`);
    }
    const body = parts.map((p) => indentLines(p, indent + '  ')).join('\n');
    return `${indent}<section id="${esc(s.id)}">\n${body}\n${indent}</section>`;
  }

  private cls(style: string | null): string {
    if (!this.settings.styleClasses || !style) return '';
    return ` class="odt-${slugify(style)}"`;
  }

  private blocks(blocks: Block[]): string[] {
    const out: string[] = [];
    let pre: string[] = [];
    const flushPre = () => {
      if (pre.length) out.push(`<pre><code>${pre.join('\n')}</code></pre>`);
      pre = [];
    };
    for (const b of blocks) {
      if (b.kind === 'para' && PRE_STYLES.test(b.style) && this.action(b.style) === 'include') {
        pre.push(this.inlines(b.inlines).replace(/<br>/g, '\n'));
        continue;
      }
      flushPre();
      const html = this.block(b);
      if (html) out.push(html);
    }
    flushPre();
    return out;
  }

  private action(style: string): ParagraphAction {
    return this.settings.paragraphStyles[style] ?? 'include';
  }

  private block(b: Block): string {
    switch (b.kind) {
      case 'para': {
        const action = this.action(b.style);
        if (action === 'exclude') return '';
        const inner = this.inlines(b.inlines).trim();
        if (!inner || /^(<br>|\s|&nbsp;)*$/.test(inner)) return '';
        if (action === 'notes') {
          this.notes.push(`<p>${inner}</p>`);
          return '';
        }
        if (b.style === 'Title') return `<h1${this.cls(b.style)}>${inner}</h1>`;
        if (b.style === 'Subtitle') return `<p class="subtitle${this.settings.styleClasses ? ' odt-subtitle' : ''}">${inner}</p>`;
        if (QUOTE_STYLES.test(b.style)) return `<blockquote${this.cls(b.style)}>${inner}</blockquote>`;
        return `<p${this.cls(b.style)}>${inner}</p>`;
      }
      case 'list': {
        const items = b.items
          .map((item) => {
            const parts = this.blocks(item.blocks);
            if (!parts.length) return '';
            // A single paragraph renders inline inside the <li> for clean markup.
            const single = parts.length === 1 && /^<p>([\s\S]*)<\/p>$/.exec(parts[0]);
            return single ? `<li>${single[1]}</li>` : `<li>\n${indentLines(parts.join('\n'), '  ')}\n</li>`;
          })
          .filter(Boolean);
        if (!items.length) return '';
        const tag = b.ordered ? 'ol' : 'ul';
        const start = b.ordered && b.start && b.start !== 1 ? ` start="${b.start}"` : '';
        return `<${tag}${start}>\n${indentLines(items.join('\n'), '  ')}\n</${tag}>`;
      }
      case 'table': {
        const rows = b.rows
          .map((row) => {
            const cells = row.map((c) => {
              const tag = c.header ? 'th' : 'td';
              const span = (c.colSpan > 1 ? ` colspan="${c.colSpan}"` : '') + (c.rowSpan > 1 ? ` rowspan="${c.rowSpan}"` : '');
              const parts = this.blocks(c.blocks);
              const single = parts.length === 1 && /^<p>([\s\S]*)<\/p>$/.exec(parts[0]);
              return `<${tag}${span}>${single ? single[1] : parts.join('')}</${tag}>`;
            });
            return `<tr>${cells.join('')}</tr>`;
          })
          .join('\n');
        return rows ? `<table>\n${indentLines(rows, '  ')}\n</table>` : '';
      }
    }
  }

  private inlines(inlines: Inline[]): string {
    return inlines.map((i) => this.inline(i)).join('');
  }

  private inline(i: Inline): string {
    switch (i.kind) {
      case 'text':
        return esc(i.text).replace(/ /g, '&nbsp;');
      case 'break':
        return '<br>';
      case 'span': {
        const action = i.style ? (this.settings.textStyles[i.style] ?? 'include') : 'include';
        if (action === 'exclude') return '';
        const fmt: TextFormat = {
          ...(action === 'include' ? i.named : {}),
          ...(this.settings.directFormatting ? i.direct : {}),
        };
        const inner = this.inlines(i.children);
        const wrapped = wrapFormat(inner, fmt);
        return action === 'include' && i.style && this.settings.styleClasses && inner
          ? `<span${this.cls(i.style)}>${wrapped}</span>`
          : wrapped;
      }
      case 'link': {
        const inner = this.inlines(i.children);
        // In-document links (bookmarks, cross-references) have no meaning in the slides.
        if (!/^(https?:|mailto:|ftp:)/i.test(i.href)) return inner;
        return `<a href="${esc(i.href)}">${inner}</a>`;
      }
      case 'image': {
        if (!this.settings.images) return '';
        const asset = this.doc.images.get(i.imageId);
        if (!asset?.supported) return '';
        const src = this.options.imageSrc(asset);
        if (!src) return '';
        const style = i.widthPx ? ` style="width: ${i.widthPx}px"` : '';
        return `<img src="${esc(src)}" alt="${esc(i.alt)}"${style}>`;
      }
      case 'math':
        return i.mathml;
      case 'note': {
        if (this.settings.footnotes === 'drop') return '';
        const text = this.blocks(i.blocks)
          .map((p) => p.replace(/^<p[^>]*>|<\/p>$/g, ''))
          .join(' ');
        if (!text) return '';
        if (this.settings.footnotes === 'notes') {
          this.notes.push(`<p class="footnote">${text}</p>`);
          return '';
        }
        this.footnotes.push(text);
        return `<sup class="footnote-ref">${this.footnotes.length}</sup>`;
      }
    }
  }
}

function wrapFormat(html: string, f: TextFormat): string {
  if (!html) return html;
  if (f.code) html = `<code>${html}</code>`;
  if (f.sub) html = `<sub>${html}</sub>`;
  if (f.sup) html = `<sup>${html}</sup>`;
  if (f.strike) html = `<s>${html}</s>`;
  if (f.underline) html = `<u>${html}</u>`;
  if (f.italic) html = `<em>${html}</em>`;
  if (f.bold) html = `<strong>${html}</strong>`;
  return html;
}

function indentLines(s: string, indent: string): string {
  if (!indent) return s;
  // Never re-indent inside <pre>, where whitespace is significant.
  const parts = s.split(/(<pre>[\s\S]*?<\/pre>)/);
  return parts
    .map((p, idx) => (idx % 2 === 1 ? p : p.replace(/(^|\n)(?=.)/g, `$1${indent}`)))
    .join('')
    .replace(/(^|\n)(<pre>)/g, `$1${indent}$2`);
}

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
