import { esc } from './render';

export const REVEAL_VERSION = '6.0.2';
const CDN = `https://cdn.jsdelivr.net/npm/reveal.js@${REVEAL_VERSION}/dist`;

export const THEMES = [
  { id: 'black', label: 'Black', dark: true },
  { id: 'white', label: 'White', dark: false },
  { id: 'league', label: 'League', dark: true },
  { id: 'beige', label: 'Beige', dark: false },
  { id: 'night', label: 'Night', dark: true },
  { id: 'serif', label: 'Serif', dark: false },
  { id: 'simple', label: 'Simple', dark: false },
  { id: 'solarized', label: 'Solarized', dark: false },
  { id: 'moon', label: 'Moon', dark: true },
  { id: 'dracula', label: 'Dracula', dark: true },
  { id: 'sky', label: 'Sky', dark: false },
  { id: 'blood', label: 'Blood', dark: true },
  { id: 'black-contrast', label: 'Black (high contrast)', dark: true },
  { id: 'white-contrast', label: 'White (high contrast)', dark: false },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];
export const TRANSITIONS = ['slide', 'fade', 'convex', 'concave', 'zoom', 'none'] as const;
export type Transition = (typeof TRANSITIONS)[number];

export interface PresentationOptions {
  title: string;
  theme: ThemeId;
  /** Base font size in px; null keeps the theme default. Headings scale with it. */
  fontSize: number | null;
  /** Heading size as a percentage of the theme's heading sizes. */
  headingScale: number;
  /** Themes like League/Black uppercase headings; false keeps the document's casing. */
  uppercaseHeadings: boolean;
  textAlign: 'center' | 'left';
  transition: Transition;
  slideNumber: boolean;
  progress: boolean;
  controls: boolean;
  center: boolean;
  /** Let slides with more content than fits scroll vertically instead of overflowing. */
  scrollableSlides: boolean;
  /** reveal.js "scroll view": the whole deck becomes one scrolling page. */
  scrollView: boolean;
  /** "inline" embeds reveal.js so the file works offline; "cdn" keeps the file small. */
  revealSource: 'inline' | 'cdn';
  customCss: string;
}

export const DEFAULT_PRESENTATION: PresentationOptions = {
  title: '',
  theme: 'white',
  fontSize: null,
  headingScale: 70,
  uppercaseHeadings: false,
  textAlign: 'left',
  transition: 'slide',
  slideNumber: true,
  progress: true,
  controls: true,
  center: true,
  scrollableSlides: true,
  scrollView: false,
  revealSource: 'inline',
  customCss: '',
};

export interface RevealAssets {
  revealCss: string;
  themeCss: string;
  revealJs: string;
  notesJs: string;
}

export interface BuildExtras {
  /** Extra Reveal.initialize options (merged last). */
  config?: Record<string, unknown>;
  /** Extra script appended after initialisation. */
  script?: string;
}

/** Wrap rendered sections in a complete, working reveal.js HTML document. */
export function buildPresentation(
  sectionsHtml: string,
  opts: PresentationOptions,
  assets: RevealAssets | null,
  extras: BuildExtras = {},
): string {
  const inline = opts.revealSource === 'inline';
  if (inline && !assets) throw new Error('reveal.js assets are required for an offline presentation.');

  const head = inline
    ? [`<style>\n${assets!.revealCss}\n</style>`, `<style id="theme">\n${assets!.themeCss}\n</style>`]
    : [
        `<link rel="stylesheet" href="${CDN}/reveal.css">`,
        `<link rel="stylesheet" href="${CDN}/theme/${opts.theme}.css" id="theme">`,
      ];
  const scripts = inline
    ? [`<script>\n${safeScript(assets!.revealJs)}\n</script>`, `<script>\n${safeScript(assets!.notesJs)}\n</script>`]
    : [`<script src="${CDN}/reveal.js"></script>`, `<script src="${CDN}/plugin/notes.js"></script>`];

  const config: Record<string, unknown> = {
    hash: true,
    controls: opts.controls,
    progress: opts.progress,
    slideNumber: opts.slideNumber,
    center: opts.center,
    transition: opts.transition,
    ...(opts.scrollView ? { view: 'scroll' } : {}),
    ...extras.config,
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="generator" content="ODT to Reveal">
<title>${esc(opts.title || 'Presentation')}</title>
${head.join('\n')}
<style>
${overrideCss(opts)}
</style>
</head>
<body>
<div class="reveal">
<div class="slides">
${sectionsHtml}
</div>
</div>
${scripts.join('\n')}
<script>
Reveal.initialize(Object.assign(${JSON.stringify(config, null, 2)}, { plugins: [RevealNotes] }));
${extras.script ?? ''}
</script>
</body>
</html>
`;
}

function overrideCss(o: PresentationOptions): string {
  const css: string[] = [];
  const root: string[] = [];
  if (o.fontSize) root.push(`--r-main-font-size: ${o.fontSize}px;`);
  if (!o.uppercaseHeadings) root.push('--r-heading-text-transform: none;');
  if (root.length) css.push(`:root {\n  ${root.join('\n  ')}\n}`);
  if (o.headingScale !== 100) {
    const f = (o.headingScale / 100).toFixed(2);
    for (let n = 1; n <= 4; n++) css.push(`.reveal h${n} { font-size: calc(var(--r-heading${n}-size) * ${f}); }`);
  }
  if (o.textAlign === 'left') {
    css.push('.reveal .slides section { text-align: left; }');
    css.push('.reveal .slides section ul, .reveal .slides section ol { display: block; }');
  }
  if (o.scrollableSlides && !o.scrollView) {
    css.push('.reveal .slides section:not(.stack) { max-height: 100%; overflow-y: auto; scrollbar-width: thin; }');
  }
  css.push(
    '.reveal section img { max-width: 100%; max-height: 520px; height: auto; object-fit: contain; }',
    '.reveal p.subtitle { font-size: 1.2em; opacity: 0.8; }',
    '.reveal ol.footnotes { display: block; font-size: 0.5em; margin-top: 1em; padding-top: 0.5em; border-top: 1px solid currentColor; opacity: 0.8; }',
    '.reveal sup.footnote-ref { font-size: 0.6em; }',
    '.reveal table { font-size: 0.8em; }',
  );
  if (o.customCss.trim()) css.push('/* Custom CSS */', o.customCss.trim());
  return css.join('\n');
}

/** Prevent inlined JS from closing its own <script> element. */
function safeScript(js: string): string {
  return js.replace(/<\/script/gi, '<\\/script');
}

/** Extract the theme's default base font size ("42px") for display in the UI. */
export function themeFontSize(themeCss: string): number | null {
  const m = /--r-main-font-size:\s*(\d+)px/.exec(themeCss);
  return m ? parseInt(m[1], 10) : null;
}
