import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOdt } from '../src/lib/odt/parse';
import { buildPresentation, DEFAULT_PRESENTATION } from '../src/lib/presentation';
import { DEFAULT_SETTINGS, renderSections, type ConversionSettings } from '../src/lib/render';
import { applyTemplate, createTemplate, DEFAULT_OUTPUT, parseTemplate } from '../src/lib/templates';
import { toDataUri } from '../src/lib/odt/images';

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));
const render = (doc: ReturnType<typeof parseOdt>, s: Partial<ConversionSettings> = {}) =>
  renderSections(doc, { ...DEFAULT_SETTINGS, ...s }, { imageSrc: (a) => (a.data ? toDataUri(a.mime, a.data) : null) });

for (const file of ['sample.odt', 'sample.fodt']) {
  describe(file, () => {
    const doc = parseOdt(fixture(file));

    it('splits the document into one section per heading', () => {
      expect(doc.title).toBe('Sample Lecture');
      expect(doc.sections.map((s) => [s.level, s.title])).toEqual([
        [0, ''],
        [1, 'Introduction'],
        [2, 'Lists & Tables'],
        [2, 'A Picture'],
        [1, 'Maths'],
        [1, 'Appendix'],
      ]);
      expect(doc.sections.map((s) => s.id)).toEqual(['intro', 'introduction', 'lists-tables', 'a-picture', 'maths', 'appendix']);
    });

    it('reports styles in use, resolving automatic styles to named ones', () => {
      const para = doc.paragraphStyles.map((s) => s.name);
      expect(para).toEqual(expect.arrayContaining(['Text body', 'Speaker Notes', 'Title', 'Subtitle', 'Quotations', 'Preformatted Text']));
      expect(para).not.toContain('P1');
      expect(doc.textStyles.map((s) => s.name).sort()).toEqual(['Draft Marker', 'Emphasis', 'Strong Emphasis']);
      expect(doc.headingStyles.map((s) => s.name).sort()).toEqual(['Heading 1', 'Heading 2']);
    });

    it('renders headings, formatting, lists, tables, notes and code', () => {
      const html = render(doc);
      expect(html).toContain('<section id="intro">');
      expect(html).toContain('<h1>Sample Lecture</h1>');
      expect(html).toContain('<p class="subtitle">A test document</p>');
      expect(html).toContain('<h2>Lists &amp; Tables</h2>');
      expect(html).toContain('<strong>strong</strong>, <em>emphasis</em>, <strong>direct bold</strong>, E=mc<sup>2</sup>');
      expect(html).toContain('<a href="https://example.com/">link</a>');
      expect(html).toMatch(/<ul>\s*<li>\s*<p>Bullet one<\/p>\s*<ul>\s*<li>Nested<\/li>/);
      expect(html).toMatch(/<ol>\s*<li>First<\/li>\s*<li>Second<\/li>\s*<\/ol>/);
      expect(html).toContain('<tr><th>Name</th><th>Value</th></tr>');
      expect(html).toContain('<aside class="notes">');
      expect(html).toContain('<p class="footnote">A footnote.</p>');
      expect(html).toContain('<pre><code>let x = 1;\nlet y = &nbsp;&nbsp;2;</code></pre>');
      expect(html).toContain('<blockquote>To be or not to be.</blockquote>');
    });

    it('embeds images and formulas', () => {
      const html = render(doc);
      expect(html).toMatch(/<img src="data:image\/png;base64,[^"]+" alt="Red box" style="width: 151px">/);
      expect(html).toMatch(/<math xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML"[^>]*>.*<mi>a<\/mi><mo[^>]*>\+<\/mo><mi>b<\/mi>/);
      expect(html).not.toContain('StarMath');
      expect(render(doc, { images: false })).not.toContain('<img');
    });

    it('applies section and style choices', () => {
      const html = render(doc, {
        sections: { maths: false, intro: false },
        paragraphStyles: { 'Speaker Notes': 'notes', Quotations: 'exclude' },
        textStyles: { 'Draft Marker': 'exclude', 'Strong Emphasis': 'plain' },
        directFormatting: false,
        footnotes: 'slide',
      });
      expect(html).not.toContain('id="maths"');
      expect(html).not.toContain('Sample Lecture');
      expect(html).not.toContain('TODO');
      expect(html).not.toContain('To be or not');
      expect(html).toContain('This has strong, <em>emphasis</em>, direct bold,');
      expect(html).toContain('<aside class="notes">\n    <p>Remember to smile.</p>');
      expect(html).toContain('<sup class="footnote-ref">1</sup>');
      expect(html).toContain('<ol class="footnotes">');
      expect(render(doc, { paragraphStyles: { 'Speaker Notes': 'exclude' } })).not.toContain('smile');
    });

    it('nests sub-headings as vertical slides', () => {
      const html = render(doc, { nesting: 'vertical' });
      expect(html).toMatch(/<section>\n  <section id="introduction">[\s\S]*<section id="a-picture">[\s\S]*?<\/section>\n<\/section>/);
    });
  });
}

describe('images', () => {
  it('flags formats browsers cannot show', () => {
    const doc = parseOdt(fixture('sample.odt'));
    const assets = [...doc.images.values()];
    expect(assets.find((a) => a.mime === 'image/png')?.supported).toBe(true);
  });
});

describe('presentation', () => {
  const doc = parseOdt(fixture('sample.odt'));
  const sections = render(doc);
  const assets = { revealCss: '.reveal{}', themeCss: ':root{--r-main-font-size:42px}', revealJs: 'var x="</script>";', notesJs: '' };

  it('builds an offline document with overrides', () => {
    const html = buildPresentation(sections, { ...DEFAULT_PRESENTATION, title: 'T & U', fontSize: 30, theme: 'black' }, assets);
    expect(html).toContain('<title>T &amp; U</title>');
    expect(html).toContain('--r-main-font-size: 30px;');
    expect(html).toContain('<\\/script>');
    expect(html).not.toContain('cdn.jsdelivr');
    expect(html).toContain('<div class="slides">\n<section id="intro">');
  });

  it('links to the CDN when requested', () => {
    const html = buildPresentation(sections, { ...DEFAULT_PRESENTATION, revealSource: 'cdn', theme: 'moon' }, null);
    expect(html).toContain('/dist/theme/moon.css');
    expect(html).toContain('"transition": "slide"');
  });
});

describe('templates', () => {
  it('round-trips choices and matches sections by heading text', () => {
    const doc = parseOdt(fixture('sample.odt'));
    const settings: ConversionSettings = {
      ...DEFAULT_SETTINGS,
      sections: { maths: false, 'lists-tables': false, 'a-picture': false },
      paragraphStyles: { 'Speaker Notes': 'notes' },
    };
    const t = parseTemplate(JSON.parse(JSON.stringify(createTemplate('Lecture', doc, settings, DEFAULT_OUTPUT))));
    expect(t.conversion.levels).toEqual({ 0: true, 1: true, 2: false });
    const applied = applyTemplate(t, doc);
    expect(applied.settings.sections).toMatchObject({ maths: false, introduction: true, 'a-picture': false });
    expect(applied.settings.paragraphStyles['Speaker Notes']).toBe('notes');
    expect(() => parseTemplate({ foo: 1 })).toThrow();
  });
});

describe('security', () => {
  it('strips scripts and event handlers from embedded MathML', () => {
    const src = new TextDecoder().decode(fixture('sample.fodt')).replace(
      '<math:mi>a</math:mi>',
      '<math:mi onclick="alert(1)">a</math:mi><math:mtext><script xmlns="http://www.w3.org/1999/xhtml">alert(2)</script></math:mtext>',
    );
    const html = render(parseOdt(new TextEncoder().encode(src)));
    expect(html).toContain('<mi>a</mi><mtext></mtext>');
    expect(html).not.toMatch(/onclick|<script|alert/);
  });
});
