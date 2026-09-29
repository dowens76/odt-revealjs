import type { TextFormat } from '../model';
import { attr, childElements, decodeStyleName, descendants, firstChild, is } from './xml';

interface StyleDef {
  name: string;
  family: string;
  displayName: string;
  parent: string | null;
  automatic: boolean;
  format: TextFormat;
  listStyle: string | null;
}

const MONO_FONTS = /mono|courier|consolas|menlo|monaco|source code|fira code|inconsolata/i;
const CODE_STYLES = /^(source text|code|source code|teletype|example|html code|html typewriter)$/i;

/**
 * Registry of every style in styles.xml and content.xml. Resolves automatic styles
 * (P1, T3, …) to the user-visible named style they are based on, and computes the
 * effective character formatting of a style chain.
 */
export class StyleRegistry {
  private styles = new Map<string, StyleDef>();
  /** list style name → per-level ordered flag */
  private listStyles = new Map<string, Map<number, boolean>>();
  private fontFamilies = new Map<string, string>();

  add(doc: Document, automatic: boolean) {
    for (const face of descendants(doc, 'style', 'font-face')) {
      const n = attr(face, 'style', 'name');
      if (n) this.fontFamilies.set(n, attr(face, 'svg', 'font-family') ?? n);
    }
    for (const el of descendants(doc, 'style', 'style')) {
      const inAuto = is(el.parentNode, 'office', 'automatic-styles');
      const name = attr(el, 'style', 'name');
      const family = attr(el, 'style', 'family') ?? 'paragraph';
      if (!name) continue;
      this.styles.set(`${family}:${name}`, {
        name,
        family,
        displayName: attr(el, 'style', 'display-name') ?? decodeStyleName(name),
        parent: attr(el, 'style', 'parent-style-name'),
        automatic: automatic || inAuto,
        format: this.readFormat(el),
        listStyle: attr(el, 'style', 'list-style-name'),
      });
    }
    for (const ls of descendants(doc, 'text', 'list-style')) {
      const name = attr(ls, 'style', 'name');
      if (!name) continue;
      const levels = new Map<number, boolean>();
      for (const lvl of childElements(ls)) {
        const level = parseInt(attr(lvl, 'text', 'level') ?? '1', 10);
        const numFormat = attr(lvl, 'style', 'num-format');
        levels.set(level, is(lvl, 'text', 'list-level-style-number') && !!numFormat);
      }
      this.listStyles.set(name, levels);
    }
  }

  private readFormat(el: Element): TextFormat {
    const tp = firstChild(el, 'style', 'text-properties');
    const f: TextFormat = {};
    if (!tp) return f;
    const weight = attr(tp, 'fo', 'font-weight');
    if (weight) f.bold = weight === 'bold' || parseInt(weight, 10) >= 600;
    const fstyle = attr(tp, 'fo', 'font-style');
    if (fstyle) f.italic = fstyle === 'italic' || fstyle === 'oblique';
    const ul = attr(tp, 'style', 'text-underline-style');
    if (ul) f.underline = ul !== 'none';
    const lt = attr(tp, 'style', 'text-line-through-style');
    if (lt) f.strike = lt !== 'none';
    const pos = attr(tp, 'style', 'text-position');
    if (pos) {
      const first = pos.trim().split(/\s+/)[0];
      f.sup = first === 'super' || (/^\d/.test(first) && parseFloat(first) > 0);
      f.sub = first === 'sub' || first.startsWith('-');
    }
    const font = attr(tp, 'style', 'font-name');
    if (font) f.code = MONO_FONTS.test(this.fontFamilies.get(font) ?? font);
    return f;
  }

  private get(family: string, name: string | null): StyleDef | undefined {
    return name ? this.styles.get(`${family}:${name}`) : undefined;
  }

  /** The user-visible style a (possibly automatic) style derives from. */
  logicalName(family: string, name: string | null): string | null {
    let s = this.get(family, name);
    const seen = new Set<string>();
    while (s && s.automatic && s.parent && !seen.has(s.name)) {
      seen.add(s.name);
      s = this.get(family, s.parent);
    }
    if (!s) return name ? decodeStyleName(name) : null;
    return s.automatic ? null : s.displayName;
  }

  /**
   * Formatting of a text style chain, split into what the named character style defines
   * and what automatic styles (direct formatting applied in the editor) add on top.
   */
  textFormats(name: string | null): { named: TextFormat; direct: TextFormat } {
    const chain: StyleDef[] = [];
    let s = this.get('text', name);
    const seen = new Set<string>();
    while (s && !seen.has(s.name)) {
      seen.add(s.name);
      chain.unshift(s);
      s = this.get('text', s.parent);
    }
    const named: TextFormat = {};
    const direct: TextFormat = {};
    for (const def of chain) Object.assign(def.automatic ? direct : named, stripUndefined(def.format));
    const logical = this.logicalName('text', name);
    if (logical && CODE_STYLES.test(logical)) named.code = true;
    return { named, direct };
  }

  paragraphListStyle(paraStyle: string | null): string | null {
    let s = this.get('paragraph', paraStyle);
    const seen = new Set<string>();
    while (s && !seen.has(s.name)) {
      seen.add(s.name);
      if (s.listStyle) return s.listStyle;
      s = this.get('paragraph', s.parent);
    }
    return null;
  }

  isOrderedList(listStyle: string | null, level: number): boolean {
    if (!listStyle) return false;
    const levels = this.listStyles.get(listStyle);
    return levels?.get(level) ?? levels?.get(1) ?? false;
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
