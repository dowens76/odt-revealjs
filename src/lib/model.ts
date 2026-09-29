/** Intermediate document model produced by the ODT parser and consumed by the renderer. */

export interface TextFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  sup?: boolean;
  sub?: boolean;
  code?: boolean;
}

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'break' }
  /**
   * `style` is the logical (named) character style, if any. `named` is the formatting that
   * style defines; `direct` is formatting applied directly in the editor (automatic styles).
   */
  | { kind: 'span'; style: string | null; named: TextFormat; direct: TextFormat; children: Inline[] }
  | { kind: 'link'; href: string; children: Inline[] }
  | { kind: 'image'; imageId: string; widthPx: number | null; heightPx: number | null; alt: string }
  | { kind: 'math'; mathml: string }
  | { kind: 'note'; noteClass: 'footnote' | 'endnote'; blocks: Block[] };

export interface ListItem {
  blocks: Block[];
}

export interface TableCell {
  blocks: Block[];
  colSpan: number;
  rowSpan: number;
  header: boolean;
}

export type Block =
  | { kind: 'para'; style: string; inlines: Inline[] }
  | { kind: 'list'; ordered: boolean; start: number | null; items: ListItem[] }
  | { kind: 'table'; rows: TableCell[][] };

export interface Section {
  /** Stable, unique, URL-friendly id derived from the heading text. */
  id: string;
  /** Outline level: 1..10 for headings; 0 for content that appears before the first heading. */
  level: number;
  title: string;
  /** Heading inlines (formatting preserved). Empty for the preamble. */
  heading: Inline[];
  headingStyle: string | null;
  blocks: Block[];
}

export interface ImageAsset {
  id: string;
  /** Path inside the ODT package, or the external URL/path for linked images. */
  path: string;
  mime: string;
  data: Uint8Array | null;
  /** True when a browser can display the format (PNG, JPEG, GIF, SVG, WebP, BMP, AVIF). */
  supported: boolean;
  linked: boolean;
}

export interface StyleUsage {
  name: string;
  count: number;
  sample: string;
}

export interface OdtDocument {
  title: string;
  sections: Section[];
  paragraphStyles: StyleUsage[];
  textStyles: StyleUsage[];
  headingStyles: StyleUsage[];
  images: Map<string, ImageAsset>;
  warnings: string[];
}
