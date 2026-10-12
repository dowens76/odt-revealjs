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
  /**
   * Add an English / Tiếng Việt picker that shows only the slides whose data-lang matches
   * (plus "both"). Needs the "Mark slide language" conversion setting to tag the slides.
   */
  languagePicker: boolean;
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
  languagePicker: false,
};

const LANGUAGE_PICKER_HTML = `<select id="lang-toggle" aria-label="Language">
  <option value="en">English</option>
  <option value="vi">Tiếng Việt</option>
</select>`;

/** Language filtering that must run before Reveal.initialize, so the deck never flashes the other language. */
export const LANGUAGE_PICKER_PRE_INIT = `const container = document.querySelector('.reveal .slides');

// Snapshot the original slide structure (including vertical stacks)
const original = new Map();
function snapshot(parent) {
  const kids = Array.from(parent.children).filter(el => el.tagName === 'SECTION');
  original.set(parent, kids);
  kids.forEach(k => { if (k.querySelector(':scope > section')) snapshot(k); });
}
snapshot(container);

function slideLang(section, inherited) {
  return section.dataset.lang || inherited;
}

function applyLanguage(lang, parent = container, inherited = 'both') {
  const keep = original.get(parent).filter(s => {
    const l = slideLang(s, inherited);
    return l === 'both' || l === lang;
  });
  parent.replaceChildren(...keep);
  keep.forEach(s => {
    if (original.has(s)) applyLanguage(lang, s, slideLang(s, inherited));
  });
  document.documentElement.lang = lang;  // helps fonts, hyphenation, screen readers
}

// Every slide (vertical-stack children included) in document order, with its language
const leaves = [];
(function collect(parent, inherited) {
  original.get(parent).forEach(s => {
    const l = slideLang(s, inherited);
    if (original.has(s)) collect(s, l); else leaves.push({ el: s, lang: l });
  });
})(container, 'both');

// The slide to show after switching: shared slides stay put; otherwise the slide at the same
// position among the other language's slides (the 3rd English slide -> the 3rd Vietnamese one)
function counterpart(slide, lang) {
  const from = leaves.find(x => x.el === slide);
  if (!from || from.lang === 'both') return slide;
  const ordinal = leaves.filter(x => x.lang === from.lang).indexOf(from);
  const candidates = leaves.filter(x => x.lang === lang);
  return candidates.length ? candidates[Math.min(ordinal, candidates.length - 1)].el : null;
}

// Keep ?lang= and the slide address in the URL, so a reload or a shared link opens the same view
function rememberLanguage(lang) {
  try {
    const url = new URL(location.href);
    url.searchParams.set('lang', lang);
    const slide = Reveal.getCurrentSlide();
    if (Reveal.getConfig().hash && slide && slide.id) url.hash = '/' + slide.id;
    history.replaceState(null, '', url);
  } catch (err) {
    // e.g. inside a sandboxed preview, where the address can't be changed
  }
}

// Initial language: ?lang=vi in the URL, otherwise English
const params = new URLSearchParams(location.search);
const startLang = params.get('lang') === 'vi' ? 'vi' : 'en';
const toggle = document.getElementById('lang-toggle');
toggle.value = startLang;
applyLanguage(startLang);   // filter before init, so there's no flash`;

/** Language switching wired up after Reveal.initialize. */
export const LANGUAGE_PICKER_POST_INIT = `toggle.addEventListener('change', e => {
  const lang = e.target.value;
  const target = counterpart(Reveal.getCurrentSlide(), lang);
  applyLanguage(lang);
  Reveal.sync();
  if (target && target.isConnected) {
    const { h, v } = Reveal.getIndices(target);
    Reveal.slide(h, v);     // the matching slide in the other language
  } else {
    Reveal.slide(0, 0);
  }
  rememberLanguage(lang);
  e.target.blur();          // give arrow keys back to reveal.js
});`;

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
${opts.languagePicker ? `${LANGUAGE_PICKER_HTML}\n` : ''}${scripts.join('\n')}
<script>
${opts.languagePicker ? `${LANGUAGE_PICKER_PRE_INIT}\n\n` : ''}Reveal.initialize(Object.assign(${JSON.stringify(config, null, 2)}, { plugins: [RevealNotes] }));
${opts.languagePicker ? `\n${LANGUAGE_PICKER_POST_INIT}\n` : ''}${extras.script ?? ''}
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
    '.reveal section.image-slide { text-align: center; }',
    // Scale every image, small ones included, to fill the slide while keeping its aspect ratio.
    '.reveal section.image-slide img { display: block; width: 100%; height: 560px; max-height: none; object-fit: contain; margin: 0 auto; }',
    '.reveal section.image-slide figure img { height: 500px; }',
    '.reveal section.image-slide figure { margin: 0; }',
    '.reveal section.image-slide figcaption { font-size: 0.6em; opacity: 0.8; margin-top: 0.4em; }',
    '.reveal p.subtitle { font-size: 1.2em; opacity: 0.8; }',
    '.reveal ol.footnotes { display: block; font-size: 0.5em; margin-top: 1em; padding-top: 0.5em; border-top: 1px solid currentColor; opacity: 0.8; }',
    '.reveal sup.footnote-ref { font-size: 0.6em; }',
    '.reveal table { font-size: 0.8em; }',
  );
  if (o.languagePicker) {
    css.push(
      '#lang-toggle { position: fixed; top: 12px; right: 12px; z-index: 40; padding: 4px 8px; border-radius: 6px; border: 1px solid currentColor;' +
        ' font: 16px var(--r-main-font, sans-serif); color: var(--r-main-color, #222); background: var(--r-background-color, #fff); opacity: 0.75; cursor: pointer; }',
      '#lang-toggle:hover, #lang-toggle:focus { opacity: 1; }',
      '@media print { #lang-toggle { display: none; } }',
    );
  }
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
