import type { ImageAsset, OdtDocument, Section } from './lib/model';
import { toDataUri } from './lib/odt/images';
import { parseOdt, plainText } from './lib/odt/parse';
import { buildPresentation, THEMES, themeFontSize, TRANSITIONS, type PresentationOptions } from './lib/presentation';
import {
  DEFAULT_SETTINGS,
  esc,
  FRAGMENT_EFFECTS,
  includedSections,
  renderSections,
  type ConversionSettings,
  type ParagraphAction,
  type TextAction,
} from './lib/render';
import { loadRevealAssets, loadThemeCss } from './lib/reveal-assets';
import { applyTemplate, createTemplate, DEFAULT_OUTPUT, parseTemplate, type OutputSettings, type Template } from './lib/templates';
import * as platform from './platform';

// ---------------------------------------------------------------- state

type Tab = 'sections' | 'styles' | 'output';

const state = {
  doc: null as OdtDocument | null,
  fileName: '',
  settings: structuredClone(DEFAULT_SETTINGS) as ConversionSettings,
  output: structuredClone(DEFAULT_OUTPUT) as OutputSettings,
  title: '',
  templates: [] as Template[],
  activeTemplate: '',
  tab: 'sections' as Tab,
  view: 'preview' as 'preview' | 'code',
  showWarnings: false,
  currentSlideId: '',
  previewIndices: { h: 0, v: 0 },
  themeDefaultFont: null as number | null,
  slideCount: 0,
};

const imageCache = new Map<string, string>();

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const panel = $('panel');
const preview = $<HTMLIFrameElement>('preview');

// ---------------------------------------------------------------- document loading

async function loadDocument(file: platform.OpenedFile) {
  let doc: OdtDocument;
  try {
    doc = parseOdt(file.bytes);
  } catch (e) {
    toast(`Could not open ${file.name}: ${errorMessage(e)}`, { error: true });
    return;
  }
  state.doc = doc;
  state.fileName = file.name;
  state.title = doc.title || file.name.replace(/\.[^.]+$/, '');
  state.currentSlideId = '';
  state.previewIndices = { h: 0, v: 0 };
  state.showWarnings = false;
  imageCache.clear();

  const template = state.templates.find((t) => t.name === state.activeTemplate);
  if (template) {
    const applied = applyTemplate(template, doc);
    state.settings = applied.settings;
    state.output = applied.output;
  } else {
    // Keep style choices from the previous document (they are keyed by name); reset sections.
    state.settings.sections = {};
    for (const s of doc.paragraphStyles) {
      if (!state.settings.paragraphStyles[s.name] && /^(speaker |presenter )?notes?$/i.test(s.name)) {
        state.settings.paragraphStyles[s.name] = 'notes';
      }
    }
  }
  renderAll();
  if (doc.sections.length <= 1 && !doc.sections.some((s) => s.level > 0)) {
    toast('No headings found — the whole document became a single slide. Apply heading styles (Heading 1, 2, …) to split it.');
  }
}

async function openDocument() {
  try {
    const file = await platform.pickDocument();
    if (file) await loadDocument(file);
  } catch (e) {
    toast(`Could not open the document: ${errorMessage(e)}`, { error: true });
  }
}

// ---------------------------------------------------------------- output generation

function imageSrc(asset: ImageAsset): string | null {
  if (asset.linked) return /^https?:/i.test(asset.path) ? asset.path : null;
  if (!asset.data) return null;
  let uri = imageCache.get(asset.id);
  if (!uri) {
    uri = toDataUri(asset.mime, asset.data);
    imageCache.set(asset.id, uri);
  }
  return uri;
}

function sectionsHtml(): string {
  return state.doc ? renderSections(state.doc, state.settings, { imageSrc }) : '';
}

function presentationOptions(): PresentationOptions {
  return { ...state.output.presentation, title: state.title };
}

async function presentationHtml(): Promise<string> {
  const opts = presentationOptions();
  const assets = opts.revealSource === 'inline' ? await loadRevealAssets(opts.theme) : null;
  return buildPresentation(sectionsHtml(), opts, assets);
}

let previewTimer = 0;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(updatePreview, 180);
}

async function updatePreview() {
  updateCounts();
  if (!state.doc) return;
  const html = sectionsHtml();
  state.slideCount = (html.match(/<section id=/g) ?? []).length;
  $('slide-count').textContent = `${state.slideCount} slides`;
  $('code').innerHTML = highlight(html);
  const opts = { ...presentationOptions(), revealSource: 'inline' as const };
  const assets = await loadRevealAssets(opts.theme);
  state.themeDefaultFont = themeFontSize(assets.themeCss);
  const { h, v } = state.previewIndices;
  // The preview runs in a sandboxed srcdoc iframe; it reports slide changes back via postMessage.
  preview.srcdoc = buildPresentation(html || '<section><p><em>No sections selected.</em></p></section>', opts, assets, {
    config: { hash: false, embedded: false },
    script: `
Reveal.on('ready', () => Reveal.slide(${h}, ${v}));
Reveal.on('slidechanged', (e) => parent.postMessage({ odtSlide: Reveal.getIndices(), id: e.currentSlide.id }, '*'));
window.addEventListener('message', (e) => {
  const el = e.data && e.data.odtGoto && document.getElementById(e.data.odtGoto);
  if (el) { const i = Reveal.getIndices(el); Reveal.slide(i.h, i.v); }
});`,
  });
  if (state.tab === 'output') {
    const hint = document.querySelector('[data-theme-default]');
    if (hint) hint.textContent = themeDefaultLabel();
  }
}

window.addEventListener('message', (e) => {
  if (e.source !== preview.contentWindow || !e.data?.odtSlide) return;
  state.previewIndices = e.data.odtSlide;
  state.currentSlideId = e.data.id ?? '';
  document.querySelectorAll('.section-item.current').forEach((el) => el.classList.remove('current'));
  document.querySelector(`.section-item[data-id="${CSS.escape(state.currentSlideId)}"]`)?.classList.add('current');
});

function gotoSlide(id: string) {
  preview.contentWindow?.postMessage({ odtGoto: id }, '*');
}

function highlight(html: string): string {
  return esc(html)
    .replace(/(&lt;\/?)([a-z0-9]+)/gi, '$1<span class="tag">$2</span>')
    .replace(/ ([a-z-]+)=(&quot;)/gi, ' <span class="attr">$1</span>=$2')
    .replace(/(data:image\/[a-z+]+;base64,)[A-Za-z0-9+/=]{40,}/g, '$1…');
}

// ---------------------------------------------------------------- rendering: chrome

function renderAll() {
  renderChrome();
  renderPanel();
  schedulePreview();
}

function renderChrome() {
  const doc = state.doc;
  $('empty').hidden = !!doc;
  $('doc-info').innerHTML = doc
    ? `<strong>${esc(state.fileName)}</strong> · ${doc.sections.filter((s) => s.level > 0).length} headings · ${doc.images.size} images`
    : '';
  $<HTMLButtonElement>('copy-btn').disabled = !doc;
  $<HTMLButtonElement>('save-btn').disabled = !doc;
  $('save-btn').textContent = state.output.mode === 'presentation' ? 'Save presentation…' : 'Save HTML…';
  $('copy-btn').textContent = 'Copy <section> HTML';

  const warnings = doc?.warnings ?? [];
  const wb = $('warnings-btn');
  wb.hidden = warnings.length === 0;
  wb.textContent = `⚠ ${warnings.length} note${warnings.length === 1 ? '' : 's'}`;
  const wl = $('warnings');
  wl.hidden = !state.showWarnings || warnings.length === 0;
  wl.innerHTML = `<ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`;

  preview.hidden = state.view !== 'preview';
  $('code').hidden = state.view !== 'code';
  document.querySelectorAll<HTMLElement>('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
  document.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === state.tab));
  renderTemplateSelect();
  updateCounts();
}

function updateCounts() {
  const doc = state.doc;
  $('tab-count-sections').textContent = doc ? `${includedSections(doc, state.settings).length}/${doc.sections.length}` : '';
  const excluded = doc
    ? doc.paragraphStyles.filter((s) => state.settings.paragraphStyles[s.name] && state.settings.paragraphStyles[s.name] !== 'include').length +
      doc.textStyles.filter((s) => state.settings.textStyles[s.name] && state.settings.textStyles[s.name] !== 'include').length
    : 0;
  $('tab-count-styles').textContent = excluded ? `${excluded} changed` : '';
  if (!doc) $('slide-count').textContent = '';
}

function renderTemplateSelect() {
  const sel = $<HTMLSelectElement>('template-select');
  sel.innerHTML =
    `<option value="">— None —</option>` +
    state.templates.map((t) => `<option value="${esc(t.name)}">${esc(t.name)}</option>`).join('');
  sel.value = state.activeTemplate;
  document.querySelectorAll<HTMLButtonElement>('[data-menu]').forEach((b) => {
    if (['update', 'rename', 'delete', 'export'].includes(b.dataset.menu!)) b.disabled = !state.activeTemplate;
  });
}

function renderPanel() {
  const scroll = panel.scrollTop;
  panel.innerHTML = state.tab === 'sections' ? sectionsPanel() : state.tab === 'styles' ? stylesPanel() : outputPanel();
  panel.scrollTop = scroll;
}

// ---------------------------------------------------------------- panel: sections

const wordCounts = new WeakMap<Section, number>();
function wordCount(s: Section): number {
  let n = wordCounts.get(s);
  if (n === undefined) {
    const text = s.blocks.map(function blockText(b): string {
      if (b.kind === 'para') return plainText(b.inlines);
      if (b.kind === 'list') return b.items.map((i) => i.blocks.map(blockText).join(' ')).join(' ');
      return b.rows.map((r) => r.map((c) => c.blocks.map(blockText).join(' ')).join(' ')).join(' ');
    });
    n = text.join(' ').split(/\s+/).filter(Boolean).length;
    wordCounts.set(s, n);
  }
  return n;
}

function sectionsPanel(): string {
  const doc = state.doc;
  if (!doc) return emptyPanel('Sections appear here once a document is open. Every heading starts a new slide.');
  const levels = [...new Set(doc.sections.map((s) => s.level))].sort();
  const chips = levels
    .map((l) => {
      const at = doc.sections.filter((s) => s.level === l);
      const on = at.filter((s) => state.settings.sections[s.id] !== false).length;
      const cls = on === at.length ? 'on' : on > 0 ? 'on partial' : '';
      return `<button class="chip ${cls}" data-level="${l}" title="Toggle all ${l ? `level ${l} headings` : 'front matter'}">${l ? `H${l}` : 'Front'} · ${at.length}</button>`;
    })
    .join('');
  const items = doc.sections
    .map((s) => {
      const on = state.settings.sections[s.id] !== false;
      const label = s.level > 0 ? esc(s.title || '(untitled heading)') : `<em>Before first heading — ${esc(frontMatterLabel(s))}</em>`;
      const indent = Math.max(0, s.level - 1) * 16;
      return `<li class="section-item ${on ? '' : 'off'} ${s.id === state.currentSlideId ? 'current' : ''}" data-id="${esc(s.id)}" style="padding-left:${indent + 6}px">
        <input type="checkbox" data-section="${esc(s.id)}" ${on ? 'checked' : ''} aria-label="Include ${esc(s.title)}">
        <span class="lvl">${s.level ? `H${s.level}` : '—'}</span>
        <span class="section-title" data-goto="${esc(s.id)}" title="${esc(s.title)} — click to preview">${label}</span>
        <span class="section-meta">${wordCount(s)} words</span>
      </li>`;
    })
    .join('');
  return `
    <div class="group">
      <p class="hint">Each heading becomes its own <code>&lt;section&gt;</code>. Unticking a heading also unticks its sub-headings. Click a title to jump to it in the preview.</p>
      <div class="sections-toolbar">
        <button class="btn small" data-all="1">All</button>
        <button class="btn small" data-all="0">None</button>
        <span class="muted small">Levels:</span>${chips}
      </div>
      <ul class="section-list">${items}</ul>
    </div>`;
}

function frontMatterLabel(s: Section): string {
  const first = s.blocks.find((b) => b.kind === 'para' && plainText(b.inlines).trim());
  const text = first && first.kind === 'para' ? plainText(first.inlines).trim() : 'content';
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

function toggleSection(id: string, on: boolean) {
  const doc = state.doc!;
  const idx = doc.sections.findIndex((s) => s.id === id);
  const level = doc.sections[idx].level;
  state.settings.sections[id] = on;
  if (level > 0) {
    for (let i = idx + 1; i < doc.sections.length && doc.sections[i].level > level; i++) {
      state.settings.sections[doc.sections[i].id] = on;
    }
  }
}

// ---------------------------------------------------------------- panel: styles

const PARA_ACTIONS: [ParagraphAction, string, string][] = [
  ['include', 'Include', 'Show on the slide'],
  ['notes', 'Notes', 'Move into speaker notes'],
  ['exclude', 'Exclude', 'Leave out entirely'],
];
const TEXT_ACTIONS: [TextAction, string, string][] = [
  ['include', 'Keep', 'Keep text and formatting'],
  ['plain', 'Plain', 'Keep text, drop the style’s formatting'],
  ['exclude', 'Remove', 'Remove this text'],
];

function stylesPanel(): string {
  const doc = state.doc;
  const s = state.settings;
  const styleRows = <A extends string>(
    list: OdtDocument['paragraphStyles'],
    kind: 'para' | 'text',
    actions: [A, string, string][],
    current: Record<string, A>,
  ) =>
    list
      .map((u) => {
        const a = current[u.name] ?? ('include' as A);
        const buttons = actions
          .map(([val, label, title]) => `<button class="${a === val ? 'on' : ''} ${val}" data-style-kind="${kind}" data-style="${esc(u.name)}" data-action="${val}" title="${title}">${label}</button>`)
          .join('');
        return `<div class="style-row ${a === 'exclude' ? 'excluded' : ''}">
          <div class="style-head"><span class="style-name" title="${esc(u.name)}">${esc(u.name)}</span><span class="style-count">×${u.count}</span><span class="seg">${buttons}</span></div>
          ${u.sample ? `<div class="style-sample">${esc(u.sample)}</div>` : ''}
        </div>`;
      })
      .join('');

  const imgs = doc ? [...doc.images.values()] : [];
  const unsupported = imgs.filter((i) => !i.supported).length;
  return `
    ${
      doc
        ? `<div class="group">
      <h4 class="group-title">Paragraph styles</h4>
      <p class="hint">Choose what happens to paragraphs of each style. “Notes” moves them into reveal.js speaker notes (press <kbd>S</kbd> during the presentation).</p>
      ${styleRows(doc.paragraphStyles, 'para', PARA_ACTIONS, s.paragraphStyles) || '<p class="hint">No paragraphs.</p>'}
    </div>
    <div class="group">
      <h4 class="group-title">Character styles</h4>
      ${styleRows(doc.textStyles, 'text', TEXT_ACTIONS, s.textStyles) || '<p class="hint">This document uses no named character styles.</p>'}
    </div>`
        : emptyPanel('Styles used in the document appear here once it is open.')
    }
    <div class="group">
      <h4 class="group-title">Content options</h4>
      <label class="check"><input type="checkbox" data-setting="directFormatting" ${s.directFormatting ? 'checked' : ''}>
        <span>Keep direct formatting<small>Bold, italic, underline etc. applied by hand rather than through a style.</small></span></label>
      <label class="check"><input type="checkbox" data-setting="images" ${s.images ? 'checked' : ''}>
        <span>Include images${doc ? ` (${imgs.length - unsupported} of ${imgs.length})` : ''}<small>Embedded in the HTML as data URIs.${unsupported ? ` ${unsupported} use a format browsers can’t display (see notes).` : ''}</small></span></label>
      <label class="check" style="margin-left:22px"><input type="checkbox" data-setting="imageSlides" ${s.imageSlides ? 'checked' : ''} ${s.images ? '' : 'disabled'}>
        <span>Put each image on its own slide<small>Right after the slide it came from, sized to fill the slide, with its caption.</small></span></label>
      <label class="check"><input type="checkbox" data-setting="styleClasses" ${s.styleClasses ? 'checked' : ''}>
        <span>Add style class names<small>e.g. <code>class="odt-quotations"</code>, so ODT styles can be targeted with custom CSS.</small></span></label>
      <div class="row"><label>List items</label>
        <select data-setting="listFragments">
          ${opt('none', 'Show all at once', s.listFragments)}${opt('top', 'One at a time (top level)', s.listFragments)}${opt('all', 'One at a time (incl. nested)', s.listFragments)}
        </select></div>
      ${
        s.listFragments !== 'none'
          ? `<div class="row"><label>Fragment effect</label>
        <select data-setting="fragmentEffect">${FRAGMENT_EFFECTS.map(([v, l]) => opt(v, l, s.fragmentEffect)).join('')}</select></div>`
          : ''
      }
      <div class="row"><label>Footnotes</label>
        <select data-setting="footnotes">
          ${opt('notes', 'Speaker notes', s.footnotes)}${opt('slide', 'Bottom of the slide', s.footnotes)}${opt('drop', 'Leave out', s.footnotes)}
        </select></div>
      <div class="row"><label>Sub-headings</label>
        <select data-setting="nesting">
          ${opt('flat', 'Separate slides, left → right', s.nesting)}${opt('vertical', 'Vertical stacks under top level', s.nesting)}
        </select></div>
    </div>`;
}

// ---------------------------------------------------------------- panel: output

const SWATCHES: Record<string, [string, string]> = {
  black: ['#191919', '#fff'], white: ['#fff', '#222'], league: ['radial-gradient(#555a5f,#1c1e20)', '#eee'],
  beige: ['radial-gradient(#fff,#f7f2d3)', '#333'], night: ['#111', '#e7ad52'], serif: ['#f0f1eb', '#383d3d'],
  simple: ['#fff', '#000'], solarized: ['#fdf6e3', '#657b83'], moon: ['#002b36', '#93a1a1'], dracula: ['#282a36', '#bd93f9'],
  sky: ['radial-gradient(#f7fbfc,#add9e4)', '#333'], blood: ['#222', '#a23'], 'black-contrast': ['#000', '#fff'], 'white-contrast': ['#fff', '#000'],
};

function themeDefaultLabel(): string {
  return state.themeDefaultFont ? `Theme default (${state.themeDefaultFont}px)` : 'Theme default';
}

function outputPanel(): string {
  const o = state.output;
  const p = o.presentation;
  const card = (mode: OutputSettings['mode'], title: string, desc: string) =>
    `<label class="mode-card ${o.mode === mode ? 'on' : ''}"><input type="radio" name="mode" data-output="mode" value="${mode}" ${o.mode === mode ? 'checked' : ''}>
      <div><strong>${title}</strong><span>${esc(desc)}</span></div></label>`;
  const themes = THEMES.map((t) => {
    const [bg, fg] = SWATCHES[t.id];
    return `<button class="theme ${p.theme === t.id ? 'on' : ''}" data-theme="${t.id}" title="${t.label}">
      <span class="swatch" style="background:${bg};color:${fg}">Aa</span><span class="label">${t.label}</span></button>`;
  }).join('');
  const check = (key: keyof OutputSettings['presentation'], label: string, hint = '') =>
    `<label class="check"><input type="checkbox" data-pres="${key}" ${p[key] ? 'checked' : ''}><span>${label}${hint ? `<small>${hint}</small>` : ''}</span></label>`;

  const presentation = `
    <div class="group">
      <h4 class="group-title">Presentation</h4>
      <div class="row"><label for="title-input">Title</label><input id="title-input" type="text" data-title value="${esc(state.title)}"></div>
    </div>
    <div class="group">
      <h4 class="group-title">Theme</h4>
      <div class="themes">${themes}</div>
    </div>
    <div class="group">
      <h4 class="group-title">Typography</h4>
      <label class="check"><input type="checkbox" data-font-default ${p.fontSize === null ? 'checked' : ''}><span data-theme-default>${themeDefaultLabel()}</span></label>
      <div class="row"><label>Base font size</label>
        <input type="range" min="16" max="64" step="1" data-pres-num="fontSize" value="${p.fontSize ?? state.themeDefaultFont ?? 40}" ${p.fontSize === null ? 'disabled' : ''}>
        <span class="value" data-out="fontSize">${p.fontSize === null ? '—' : `${p.fontSize}px`}</span></div>
      <div class="row"><label>Heading size</label>
        <input type="range" min="40" max="130" step="5" data-pres-num="headingScale" value="${p.headingScale}">
        <span class="value" data-out="headingScale">${p.headingScale}%</span></div>
      <div class="row"><label>Text alignment</label>
        <select data-pres="textAlign">${opt('left', 'Left', p.textAlign)}${opt('center', 'Centered', p.textAlign)}</select></div>
      ${check('uppercaseHeadings', 'Uppercase headings', 'Some themes (League, Black, …) capitalise all headings.')}
    </div>
    <div class="group">
      <h4 class="group-title">Behaviour</h4>
      <div class="row"><label>Transition</label>
        <select data-pres="transition">${TRANSITIONS.map((t) => opt(t, t[0].toUpperCase() + t.slice(1), p.transition)).join('')}</select></div>
      ${check('slideNumber', 'Slide numbers')}
      ${check('progress', 'Progress bar')}
      ${check('controls', 'Navigation arrows')}
      ${check('center', 'Centre slides vertically')}
      ${check('scrollableSlides', 'Scroll long slides', 'Slides with more text than fits get a scrollbar instead of being cut off.')}
      ${check('scrollView', 'Scroll view', 'Show the whole deck as one scrolling page (good for reading on phones).')}
    </div>
    <div class="group">
      <h4 class="group-title">reveal.js files</h4>
      <label class="check"><input type="radio" name="src" data-pres="revealSource" value="inline" ${p.revealSource === 'inline' ? 'checked' : ''}>
        <span>Embed in the HTML file<small>One self-contained file that works offline (≈0.3–0.8 MB plus images).</small></span></label>
      <label class="check"><input type="radio" name="src" data-pres="revealSource" value="cdn" ${p.revealSource === 'cdn' ? 'checked' : ''}>
        <span>Load from CDN<small>Much smaller file, but needs an internet connection to present.</small></span></label>
    </div>
    <div class="group">
      <h4 class="group-title">Custom CSS</h4>
      <textarea data-pres="customCss" spellcheck="false" placeholder=".reveal h2 { color: tomato; }">${esc(p.customCss)}</textarea>
    </div>`;

  return `
    <div class="group">
      <h4 class="group-title">Output</h4>
      <div class="mode-cards">
        ${card('presentation', 'Complete reveal.js presentation', 'A ready-to-present .html file with theme and settings below.')}
        ${card('html', 'HTML sections only', 'Just the <section> markup, to paste into an existing reveal.js deck.')}
      </div>
    </div>
    ${o.mode === 'presentation' ? presentation : '<p class="hint">Images are embedded as data URIs so the markup is self-contained. The preview uses the presentation settings from the other mode.</p>'}`;
}

function opt(value: string, label: string, current: string): string {
  return `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`;
}

function emptyPanel(msg: string): string {
  return `<p class="hint" style="margin-top:8px">${msg}</p>`;
}

// ---------------------------------------------------------------- panel events

panel.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const btn = t.closest<HTMLElement>('button, [data-goto]');
  if (!btn) return;
  const d = btn.dataset;
  if (d.goto) return gotoSlide(d.goto);
  if (d.all && state.doc) {
    for (const s of state.doc.sections) state.settings.sections[s.id] = d.all === '1';
  } else if (d.level && state.doc) {
    const level = +d.level;
    const at = state.doc.sections.filter((s) => s.level === level);
    const allOn = at.every((s) => state.settings.sections[s.id] !== false);
    for (const s of at) state.settings.sections[s.id] = !allOn;
  } else if (d.style && d.action) {
    const map = d.styleKind === 'para' ? state.settings.paragraphStyles : state.settings.textStyles;
    (map as Record<string, string>)[d.style] = d.action;
  } else if (d.theme) {
    state.output.presentation.theme = d.theme as PresentationOptions['theme'];
    void loadThemeCss(state.output.presentation.theme).then((css) => {
      state.themeDefaultFont = themeFontSize(css);
      renderPanel();
    });
  } else return;
  renderPanel();
  updateCounts();
  schedulePreview();
});

panel.addEventListener('change', (e) => {
  const t = e.target as HTMLInputElement;
  const d = t.dataset;
  if (d.section) toggleSection(d.section, t.checked);
  else if (d.setting) {
    const key = d.setting as keyof ConversionSettings;
    (state.settings as unknown as Record<string, unknown>)[key] = t.type === 'checkbox' ? t.checked : t.value;
  } else if (d.output === 'mode') {
    state.output.mode = t.value as OutputSettings['mode'];
    renderChrome();
  } else if (d.fontDefault !== undefined) {
    state.output.presentation.fontSize = t.checked ? null : (state.themeDefaultFont ?? 40);
  } else if (d.pres) {
    const p = state.output.presentation as unknown as Record<string, unknown>;
    p[d.pres] = t.type === 'checkbox' ? t.checked : t.value;
    if (d.pres === 'customCss') return; // handled on input, no re-render (keeps the caret)
  } else return;
  renderPanel();
  updateCounts();
  schedulePreview();
});

panel.addEventListener('input', (e) => {
  const t = e.target as HTMLInputElement;
  const d = t.dataset;
  if (d.title !== undefined) state.title = t.value;
  else if (d.pres === 'customCss') state.output.presentation.customCss = t.value;
  else if (d.presNum) {
    const key = d.presNum as 'fontSize' | 'headingScale';
    state.output.presentation[key] = +t.value;
    const out = panel.querySelector(`[data-out="${key}"]`);
    if (out) out.textContent = key === 'fontSize' ? `${t.value}px` : `${t.value}%`;
  } else return;
  schedulePreview();
});

// ---------------------------------------------------------------- export actions

async function saveOutput() {
  if (!state.doc) return;
  const base = (state.title || state.fileName.replace(/\.[^.]+$/, '') || 'presentation').replace(/[\\/:*?"<>|]+/g, '-').trim();
  try {
    const isPres = state.output.mode === 'presentation';
    const html = isPres ? await presentationHtml() : sectionsHtml() + '\n';
    const saved = await platform.saveTextFile(isPres ? `${base}.html` : `${base} (sections).html`, html, { name: 'HTML', extensions: ['html', 'htm'] });
    if (!saved) return;
    const actions = saved.path && platform.isTauri
      ? [
          ...(isPres ? [{ label: 'Open', run: () => platform.openInDefaultApp(saved.path!) }] : []),
          { label: 'Show in folder', run: () => platform.showInFolder(saved.path!) },
        ]
      : [];
    toast(`Saved ${saved.name}`, { actions });
  } catch (e) {
    toast(`Could not save: ${errorMessage(e)}`, { error: true });
  }
}

async function copyOutput() {
  if (!state.doc) return;
  try {
    await platform.copyText(sectionsHtml());
    toast(`Copied ${includedSections(state.doc, state.settings).length} <section> elements to the clipboard`);
  } catch (e) {
    toast(`Could not copy: ${errorMessage(e)}`, { error: true });
  }
}

// ---------------------------------------------------------------- templates

async function persistTemplates() {
  try {
    await platform.saveTemplates(state.templates);
  } catch (e) {
    toast(`Could not save templates: ${errorMessage(e)}`, { error: true });
  }
}

function upsertTemplate(t: Template) {
  const i = state.templates.findIndex((x) => x.name === t.name);
  if (i >= 0) state.templates[i] = t;
  else state.templates.push(t);
  state.templates.sort((a, b) => a.name.localeCompare(b.name));
  state.activeTemplate = t.name;
}

async function saveTemplateAs() {
  const name = await promptDialog('Save template', 'Saves section, style and output choices so you can reuse them on other documents.', state.activeTemplate || state.title || 'My template');
  if (!name) return;
  if (state.templates.some((t) => t.name === name) && !(await confirmDialog('Replace template?', `A template called “${name}” already exists.`))) return;
  upsertTemplate(createTemplate(name, state.doc, state.settings, state.output));
  await persistTemplates();
  renderTemplateSelect();
  toast(`Template “${name}” saved`);
}

async function templateMenu(action: string) {
  const current = state.templates.find((t) => t.name === state.activeTemplate);
  switch (action) {
    case 'update':
      if (!current) return;
      upsertTemplate(createTemplate(current.name, state.doc, state.settings, state.output));
      await persistTemplates();
      toast(`Template “${current.name}” updated`);
      break;
    case 'rename': {
      if (!current) return;
      const name = await promptDialog('Rename template', '', current.name);
      if (!name || name === current.name) return;
      if (state.templates.some((t) => t.name === name)) return toast(`A template called “${name}” already exists.`, { error: true });
      current.name = name;
      state.activeTemplate = name;
      await persistTemplates();
      break;
    }
    case 'delete':
      if (!current || !(await confirmDialog('Delete template?', `“${current.name}” will be removed permanently.`))) return;
      state.templates = state.templates.filter((t) => t !== current);
      state.activeTemplate = '';
      await persistTemplates();
      break;
    case 'import':
      try {
        const text = await platform.readTextFile({ name: 'Template', extensions: ['json'] });
        if (!text) return;
        const t = parseTemplate(JSON.parse(text));
        let name = t.name;
        for (let n = 2; state.templates.some((x) => x.name === name); n++) name = `${t.name} (${n})`;
        upsertTemplate({ ...t, name });
        await persistTemplates();
        applyActiveTemplate();
        toast(`Imported template “${name}”`);
      } catch (e) {
        toast(`Could not import: ${errorMessage(e)}`, { error: true });
      }
      break;
    case 'export':
      if (!current) return;
      try {
        await platform.saveTextFile(`${current.name}.json`, JSON.stringify(current, null, 2), { name: 'Template', extensions: ['json'] });
      } catch (e) {
        toast(`Could not export: ${errorMessage(e)}`, { error: true });
      }
      break;
  }
  renderTemplateSelect();
}

function applyActiveTemplate() {
  const t = state.templates.find((x) => x.name === state.activeTemplate);
  if (!t) return;
  const applied = applyTemplate(t, state.doc);
  state.settings = applied.settings;
  state.output = applied.output;
  renderAll();
}

// ---------------------------------------------------------------- dialogs & toasts

const dialog = $<HTMLDialogElement>('dialog');

function showDialog(title: string, message: string, value: string | null): Promise<string | null> {
  $('dialog-title').textContent = title;
  $('dialog-message').textContent = message;
  $('dialog-message').hidden = !message;
  const input = $<HTMLInputElement>('dialog-input');
  input.hidden = value === null;
  input.value = value ?? '';
  input.required = value !== null;
  dialog.returnValue = '';
  dialog.showModal();
  if (value !== null) input.select();
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => resolve(dialog.returnValue === 'ok' ? (value === null ? 'ok' : input.value.trim() || null) : null),
      { once: true },
    );
  });
}

const promptDialog = (title: string, message: string, value: string) => showDialog(title, message, value);
const confirmDialog = async (title: string, message: string) => (await showDialog(title, message, null)) === 'ok';

function toast(message: string, opts: { error?: boolean; actions?: { label: string; run: () => unknown }[] } = {}) {
  const el = document.createElement('div');
  el.className = `toast ${opts.error ? 'error' : ''}`;
  el.innerHTML = `<span>${esc(message)}</span>`;
  for (const a of opts.actions ?? []) {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = a.label;
    b.onclick = () => {
      Promise.resolve(a.run()).catch((e) => toast(errorMessage(e), { error: true }));
      el.remove();
    };
    el.append(b);
  }
  $('toasts').append(el);
  setTimeout(() => el.remove(), opts.actions?.length ? 9000 : opts.error ? 7000 : 3500);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// ---------------------------------------------------------------- global wiring

$('open-btn').onclick = openDocument;
$('empty-open-btn').onclick = openDocument;
$('save-btn').onclick = saveOutput;
$('copy-btn').onclick = copyOutput;
$('warnings-btn').onclick = () => {
  state.showWarnings = !state.showWarnings;
  renderChrome();
};
$('fullscreen-btn').onclick = () => preview.requestFullscreen?.().catch(() => toast('Full screen is not available here — press F inside the preview instead.'));
preview.setAttribute('allowfullscreen', '');

document.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) =>
  b.addEventListener('click', () => {
    state.tab = b.dataset.tab as Tab;
    panel.scrollTop = 0;
    renderChrome();
    renderPanel();
  }),
);
document.querySelectorAll<HTMLElement>('[data-view]').forEach((b) =>
  b.addEventListener('click', () => {
    state.view = b.dataset.view as 'preview' | 'code';
    renderChrome();
  }),
);

$<HTMLSelectElement>('template-select').addEventListener('change', (e) => {
  state.activeTemplate = (e.target as HTMLSelectElement).value;
  if (state.activeTemplate) {
    applyActiveTemplate();
    toast(`Applied template “${state.activeTemplate}”`);
  } else renderTemplateSelect();
});
$('template-save').onclick = saveTemplateAs;
const menu = $('template-menu');
$('template-menu-btn').onclick = (e) => {
  e.stopPropagation();
  menu.hidden = !menu.hidden;
};
menu.addEventListener('click', (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>('[data-menu]')?.dataset.menu;
  menu.hidden = true;
  if (action) void templateMenu(action);
});
document.addEventListener('click', () => (menu.hidden = true));

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  if (e.key === 'o') {
    e.preventDefault();
    void openDocument();
  } else if (e.key === 's') {
    e.preventDefault();
    void saveOutput();
  }
});

void platform.onDocumentDrop(
  (active) => ($('drop-overlay').hidden = !active),
  (file) => {
    if (!platform.isDocumentName(file.name)) return toast(`${file.name} is not an .odt or .fodt file.`, { error: true });
    void loadDocument(file);
  },
  (e) => toast(`Could not open the dropped file: ${errorMessage(e)}`, { error: true }),
);

(async () => {
  state.templates = (await platform.loadTemplates()).sort((a, b) => a.name.localeCompare(b.name));
  state.themeDefaultFont = themeFontSize(await loadThemeCss(state.output.presentation.theme));
  renderAll();
})();
