import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOdt } from '../src/lib/odt/parse';
import { buildPresentation, DEFAULT_PRESENTATION, LANGUAGE_PICKER_POST_INIT, LANGUAGE_PICKER_PRE_INIT } from '../src/lib/presentation';
import { DEFAULT_SETTINGS, languagePairWarnings, renderSections, type ConversionSettings } from '../src/lib/render';
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

    it('turns list items into fragments', () => {
      const top = render(doc, { listFragments: 'top' });
      expect(top).toMatch(/<ul>\s*<li class="fragment">\s*<p>Bullet one<\/p>\s*<ul>\s*<li>Nested<\/li>/);
      expect(top).toContain('<li class="fragment">Second</li>');
      const all = render(doc, { listFragments: 'all', fragmentEffect: 'fade-up' });
      expect(all).toContain('<li class="fragment fade-up">Nested</li>');
      expect(render(doc)).not.toContain('fragment');
    });

    it('can put images on their own slides', () => {
      const html = render(doc, { imageSlides: true });
      expect(html).toMatch(/<section id="a-picture">\n  <h2>A Picture<\/h2>\n<\/section>\n\n<section id="a-picture-image-1" class="image-slide">\n  <img src="data:image\/png;base64,[^"]+" alt="Red box">\n<\/section>/);
      expect(render(doc, { imageSlides: true, images: false })).not.toContain('image-slide');
      // In vertical mode the image slide joins its heading's stack.
      const nested = render(doc, { imageSlides: true, nesting: 'vertical' });
      expect(nested).toMatch(/<section>\n  <section id="introduction">[\s\S]*  <section id="a-picture-image-1" class="image-slide">[\s\S]*?<\/section>\n<\/section>\n\n<section id="maths">/);
      expect(nested).toContain('<pre><code>let x = 1;\nlet y = &nbsp;&nbsp;2;</code></pre>');
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

  it('can hide the scrollbar on scrollable slides', () => {
    const hidden = buildPresentation(sections, { ...DEFAULT_PRESENTATION, hideScrollbar: true }, assets);
    expect(hidden).toContain('overflow-y: auto');
    expect(hidden).toContain('scrollbar-width: none;');
    expect(hidden).toContain('::-webkit-scrollbar { display: none; }');
    expect(buildPresentation(sections, DEFAULT_PRESENTATION, assets)).not.toContain('scrollbar-width: none');
    // Nothing to hide when slides don't scroll.
    expect(buildPresentation(sections, { ...DEFAULT_PRESENTATION, hideScrollbar: true, scrollableSlides: false }, assets)).not.toContain('scrollbar-width: none');
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

describe('captions', () => {
  // LibreOffice stores a captioned image as an outer frame holding a text box with the image frame and the caption text.
  const src = new TextDecoder().decode(fixture('sample.fodt'));
  const start = src.indexOf('<draw:frame draw:style-name="fr1"');
  const end = src.indexOf('</draw:frame>', start) + '</draw:frame>'.length;
  const captioned = src.slice(0, start) +
    `<draw:frame svg:width="4cm"><draw:text-box><text:p text:style-name="Caption">${src.slice(start, end)}<text:line-break/>Figure 1: A <text:span text:style-name="Emphasis">red</text:span> box</text:p></draw:text-box></draw:frame>` +
    src.slice(end);
  const doc = parseOdt(new TextEncoder().encode(captioned));

  it('keeps the caption under an inline image', () => {
    expect(render(doc)).toMatch(/<p><img [^>]+ style="width: 151px"><br>Figure 1: A <em>red<\/em> box<\/p>/);
  });

  it('moves image and caption together onto the image slide', () => {
    const html = render(doc, { imageSlides: true });
    expect(html).toMatch(/<section id="a-picture-image-1" class="image-slide">\n  <figure>\n    <img [^>]+>\n    <figcaption>Figure 1: A <em>red<\/em> box<\/figcaption>\n  <\/figure>\n<\/section>/);
    expect(html).not.toMatch(/<section id="a-picture">[\s\S]*?Figure 1[\s\S]*?<\/section>\n\n<section id="a-picture-image-1"/);
  });
});

describe('language attributes', () => {
  const src = new TextDecoder().decode(fixture('sample.fodt'))
    .replace(
      '<style:style style:name="Emphasis"',
      '<style:style style:name="Text_20_body_20_VI" style:display-name="Text body VI" style:family="paragraph"/>' +
        '<style:style style:name="Notes_20_VI" style:display-name="Notes VI" style:family="paragraph"/>' +
        '<style:style style:name="Emphasis_20_VI" style:display-name="Emphasis VI" style:family="text"/>' +
        '<style:style style:name="Emphasis"',
    )
    .replace('<text:p text:style-name="Text_20_body">Bullet one</text:p>', '<text:p text:style-name="Text_20_body_20_VI">Bullet one</text:p>')
    .replace('<text:h text:style-name="Heading_20_1" text:outline-level="1">Appendix</text:h>',
      '<text:p text:style-name="Text_20_body">Tổng <text:span text:style-name="Emphasis_20_VI">kết</text:span></text:p>' +
        '<text:h text:style-name="Heading_20_1" text:outline-level="1">Appendix</text:h>' +
        '<text:p text:style-name="Notes_20_VI">Ghi chú</text:p>');
  const doc = parseOdt(new TextEncoder().encode(src));
  const langs = (html: string) => [...html.matchAll(/<section id="([^"]+)"[^>]*?(?: data-lang="(\w+)")?>/g)].map((m) => [m[1], m[2]]);

  it('marks slides with VI styles as vi, others as en and image slides as both', () => {
    const html = render(doc, { langAttributes: true, imageSlides: true, paragraphStyles: { 'Notes VI': 'notes' } });
    expect(langs(html)).toEqual([
      // The title slide is shared by both languages.
      ['intro', 'both'],
      ['introduction', 'en'],
      ['lists-tables', 'vi'],
      ['a-picture', 'en'],
      ['a-picture-image-1', 'both'],
      ['maths', 'vi'],
      // A VI style in the speaker notes doesn't make the slide Vietnamese.
      ['appendix', 'en'],
    ]);
  });

  it('ignores excluded VI content and is off by default', () => {
    const html = render(doc, { langAttributes: true, paragraphStyles: { 'Text body VI': 'exclude' }, textStyles: { 'Emphasis VI': 'exclude' } });
    expect(html).toContain('<section id="lists-tables" data-lang="en">');
    expect(html).toContain('<section id="maths" data-lang="en">');
    expect(render(doc)).not.toContain('data-lang');
  });
});

describe('translated heading pairs', () => {
  const h = (style: string, text: string) => `<text:h text:style-name="${style}" text:outline-level="1">${text}</text:h>`;
  const p = (style: string, text: string) => `<text:p text:style-name="${style}">${text}</text:p>`;
  const base = new TextDecoder().decode(fixture('sample.fodt'));
  const image = base.slice(base.indexOf('<text:p text:style-name="Text_20_body"><draw:frame'), base.indexOf('</text:p>', base.indexOf('<draw:frame draw:style-name="fr1"')) + '</text:p>'.length);
  const styles =
    '<style:style style:name="Heading_20_1_20_VI" style:display-name="Heading 1 VI" style:family="paragraph" style:parent-style-name="Heading"/>' +
    '<style:style style:name="Body_20_Text_20_VI" style:display-name="Body Text VI" style:family="paragraph"/>' +
    '<style:style style:name="Notes_20_VI" style:display-name="Notes VI" style:family="paragraph"/>' +
    '<style:style style:name="Notes_20_EN" style:display-name="Notes EN" style:family="paragraph"/>';
  const body =
    // Heading pair, English first: all content sits under the Vietnamese heading.
    h('Heading_20_1', 'Introduction') + h('Heading_20_1_20_VI', 'Giới thiệu') +
    p('Text_20_body', 'English one.') + p('Body_20_Text_20_VI', 'Tiếng Việt một.') +
    image +
    `<text:list text:style-name="L2"><text:list-item>${p('Body_20_Text_20_VI', 'Mục')}</text:list-item></text:list>` +
    p('Text_20_body', 'English two.') + p('Notes_20_EN', 'Say hello.') + p('Notes_20_VI', 'Xin chào.') +
    // Pair in the other order.
    h('Heading_20_1_20_VI', 'Kết luận') + h('Heading_20_1', 'Conclusion') +
    p('Body_20_Text_20_VI', 'Hết.') + p('Text_20_body', 'The end.') +
    // An ordinary heading, not part of a pair.
    h('Heading_20_1', 'Appendix') + p('Text_20_body', 'Extra.');
  const src = base
    .replace('<style:style style:name="Emphasis"', styles + '<style:style style:name="Emphasis"')
    .replace(/(<office:text>)[\s\S]*(<\/office:text>)/, `$1${body}$2`);
  const doc = parseOdt(new TextEncoder().encode(src));
  const settings = { langAttributes: true, paragraphStyles: { 'Notes VI': 'notes', 'Notes EN': 'notes' } } as const;
  const slide = (html: string, id: string) => html.slice(html.indexOf(`<section id="${id}"`), html.indexOf('</section>', html.indexOf(`<section id="${id}"`)));

  it('gives each heading of a pair the content in its own language', () => {
    const html = render(doc, settings);
    const en = slide(html, 'introduction');
    const vi = slide(html, 'gioi-thieu');
    expect(en).toContain('data-lang="en"');
    expect(en).toMatch(/English one\.[\s\S]*<img[\s\S]*English two\./);
    expect(en).toContain('<p>Say hello.</p>');
    expect(en).not.toMatch(/Tiếng Việt|Mục|Xin chào/);
    expect(vi).toContain('data-lang="vi"');
    expect(vi).toMatch(/Tiếng Việt một\.[\s\S]*<img[\s\S]*<li>Mục<\/li>/);
    expect(vi).toContain('<p>Xin chào.</p>');
    expect(vi).not.toMatch(/English|Say hello/);
  });

  it('works with the Vietnamese heading first and leaves unpaired headings alone', () => {
    const html = render(doc, settings);
    expect(slide(html, 'ket-luan')).toMatch(/data-lang="vi">[\s\S]*Hết\./);
    expect(slide(html, 'ket-luan')).not.toContain('The end.');
    expect(slide(html, 'conclusion')).toMatch(/data-lang="en">[\s\S]*The end\./);
    expect(slide(html, 'appendix')).toMatch(/data-lang="en">[\s\S]*Extra\./);
  });

  it('keeps English content when the Vietnamese heading is excluded', () => {
    const html = render(doc, { ...settings, sections: { 'gioi-thieu': false } });
    expect(html).not.toContain('id="gioi-thieu"');
    expect(slide(html, 'introduction')).toContain('English two.');
  });

  it('gives image slides the language of their half of the pair', () => {
    const html = render(doc, { ...settings, imageSlides: true });
    expect(html).toContain('<section id="introduction-image-1" class="image-slide" data-lang="en">');
    expect(html).toContain('<section id="gioi-thieu-image-1" class="image-slide" data-lang="vi">');
  });

  it('only sorts content when language marking is on', () => {
    expect(slide(render(doc), 'gioi-thieu')).toContain('English one.');
  });
});

describe('bilingual lists and mis-levelled translations', () => {
  // Modelled on a real bilingual teaching document.
  const hl = (style: string, level: number, text: string) => `<text:h text:style-name="${style}" text:outline-level="${level}">${text}</text:h>`;
  const p = (style: string, text: string) => `<text:p text:style-name="${style}">${text}</text:p>`;
  const li = (...content: string[]) => `<text:list-item>${content.join('')}</text:list-item>`;
  const ul = (...items: string[]) => `<text:list text:style-name="L2">${items.join('')}</text:list>`;
  const styles =
    '<style:style style:name="Heading_20_1_20_VI" style:display-name="Heading 1 VI" style:family="paragraph" style:parent-style-name="Heading"/>' +
    '<style:style style:name="Text_20_body_20_VI" style:display-name="Text body VI" style:family="paragraph"/>';
  const body =
    hl('Heading_20_1', 4, 'Ministers who take the word seriously.') +
    // The translation was styled one level too high, and all the content sits under it.
    hl('Heading_20_1_20_VI', 3, 'Người hầu việc nghiêm túc.') +
    p('Text_20_body', 'Deut 18:18.') + p('Text_20_body_20_VI', 'Phục Truyền 18:18.') +
    // Items alternate English and Vietnamese, with a nested list and a two-language item.
    ul(li(p('Text_20_body', 'We take it seriously.')), li(p('Text_20_body_20_VI', 'Chúng ta nghiêm túc.'))) +
    ul(li(ul(li(p('Text_20_body', 'Under judgment.')), li(p('Text_20_body_20_VI', 'Chịu phán xét.'))))) +
    ul(li(p('Text_20_body', 'Every part.'), p('Text_20_body_20_VI', 'Mọi phần.'))) +
    hl('Heading_20_1', 4, 'Servants of the word.') + hl('Heading_20_1_20_VI', 4, 'Đầy tớ của Lời Chúa.') +
    p('Text_20_body', 'Servants.') + p('Text_20_body_20_VI', 'Đầy tớ.');
  const base = new TextDecoder().decode(fixture('sample.fodt'));
  const src = base
    .replace('<style:style style:name="Emphasis"', styles + '<style:style style:name="Emphasis"')
    .replace(/(<office:text>)[\s\S]*(<\/office:text>)/, `$1${body}$2`);
  const doc = parseOdt(new TextEncoder().encode(src));
  const slide = (html: string, id: string) => html.slice(html.indexOf(`<section id="${id}"`), html.indexOf('</section>', html.indexOf(`<section id="${id}"`)));

  it('pairs a translation styled at a different level and shows it at its partner’s level', () => {
    const html = render(doc, { langAttributes: true });
    const en = slide(html, 'ministers-who-take-the-word-seriously');
    const vi = slide(html, 'nguoi-hau-viec-nghiem-tuc');
    expect(en).toMatch(/data-lang="en">\s*<h4>[\s\S]*Deut 18:18\./);
    expect(vi).toMatch(/data-lang="vi">\s*<h4>Người hầu việc nghiêm túc\.<\/h4>[\s\S]*Phục Truyền 18:18\./);
    expect(en).not.toContain('Phục Truyền');
    expect(vi).not.toContain('Deut');
  });

  it('sorts list items by language, keeping nesting and splitting two-language items', () => {
    const html = render(doc, { langAttributes: true });
    const en = slide(html, 'ministers-who-take-the-word-seriously');
    const vi = slide(html, 'nguoi-hau-viec-nghiem-tuc');
    expect(en).toMatch(/<ul>\s*<li>We take it seriously\.<\/li>\s*<\/ul>/);
    expect(en).toMatch(/<ul>\s*<li>\s*<ul>\s*<li>Under judgment\.<\/li>\s*<\/ul>\s*<\/li>\s*<\/ul>/);
    expect(en).toMatch(/<li>Every part\.<\/li>/);
    expect(vi).toMatch(/<ul>\s*<li>Chúng ta nghiêm túc\.<\/li>\s*<\/ul>/);
    expect(vi).toMatch(/<li>\s*<ul>\s*<li>Chịu phán xét\.<\/li>/);
    expect(vi).toMatch(/<li>Mọi phần\.<\/li>/);
    expect(en).not.toMatch(/Chúng ta|Chịu|Mọi/);
    expect(vi).not.toMatch(/We take|Under|Every/);
  });

  it('flags the mis-levelled pair but not correctly styled ones', () => {
    const notes = languagePairWarnings(doc);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('“Người hầu việc nghiêm túc.” (Heading 1 VI) looks like the translation of “Ministers who take the word seriously.”');
    expect(notes[0]).toContain('level 3, not 4');
  });

  it('does not pair across levels when the first heading has its own content', () => {
    const own = src.replace(hl('Heading_20_1_20_VI', 3, 'Người hầu việc nghiêm túc.'), p('Text_20_body', 'Own.') + hl('Heading_20_1_20_VI', 3, 'Người hầu việc nghiêm túc.'));
    expect(languagePairWarnings(parseOdt(new TextEncoder().encode(own)))).toEqual([]);
  });
});

describe('language picker', () => {
  const assets = { revealCss: '', themeCss: '', revealJs: '', notesJs: '' };
  const slides = [
    '<section id="t" data-lang="both"><h1>Title</h1></section>',
    '<section data-lang="en"><section id="a" data-lang="en">A</section><section id="a-img" data-lang="both">img</section></section>',
    '<section data-lang="vi"><section id="b" data-lang="vi">B</section><section id="b-img" data-lang="both">img</section></section>',
    '<section id="c">no tag</section>',
  ].join('\n');

  it('adds the picker and wraps Reveal.initialize with the language script only when enabled', () => {
    const html = buildPresentation(slides, { ...DEFAULT_PRESENTATION, languagePicker: true }, assets);
    expect(html).toContain('<select id="lang-toggle" aria-label="Language">');
    expect(html).toContain('<option value="vi">Tiếng Việt</option>');
    const pre = html.indexOf('applyLanguage(startLang);');
    const init = html.indexOf('Reveal.initialize(');
    const listener = html.indexOf("toggle.addEventListener('change'");
    expect(pre).toBeGreaterThan(0);
    expect(init).toBeGreaterThan(pre);
    expect(listener).toBeGreaterThan(init);
    expect(html).toContain('#lang-toggle {');
    const off = buildPresentation(slides, DEFAULT_PRESENTATION, assets);
    expect(off).not.toContain('lang-toggle');
    expect(off).not.toContain('applyLanguage');
  });

  it('keeps only the chosen language plus "both", including inside vertical stacks', () => {
    document.body.innerHTML = `<div class="reveal"><div class="slides">${slides}</div></div><select id="lang-toggle"><option value="en"></option><option value="vi"></option></select>`;
    // Run the shipped script, then expose applyLanguage to switch languages.
    const applyLanguage = new Function(`${LANGUAGE_PICKER_PRE_INIT}\nreturn applyLanguage;`)() as (lang: string) => void;
    const ids = () => [...document.querySelectorAll('.slides section[id]')].map((s) => s.id);
    // Untagged slides inherit "both" from the root, so they show in every language.
    expect(ids()).toEqual(['t', 'a', 'a-img', 'c']);
    expect(document.documentElement.lang).toBe('en');
    applyLanguage('vi');
    expect(ids()).toEqual(['t', 'b', 'b-img', 'c']);
    expect(document.documentElement.lang).toBe('vi');
    applyLanguage('en');
    expect(ids()).toEqual(['t', 'a', 'a-img', 'c']);
  });

  it('switches to the matching slide and remembers the language in the URL', () => {
    const deck = [
      '<section id="t" data-lang="both">Title</section>',
      '<section id="e1" data-lang="en">E1</section>',
      '<section id="v1" data-lang="vi">V1</section>',
      // Like the app's vertical stacks: the wrapper has no data-lang, its slides do.
      '<section><section id="e2" data-lang="en">E2</section><section id="e2-img" data-lang="both">img</section></section>',
      '<section id="v2" data-lang="vi">V2</section>',
    ].join('');
    document.body.innerHTML = `<div class="reveal"><div class="slides">${deck}</div></div><select id="lang-toggle"><option value="en"></option><option value="vi"></option></select>`;
    history.replaceState(null, '', '/deck.html#/e2');
    // Minimal stand-in for reveal.js: a slide's "indices" are the element itself.
    let current: Element = document.getElementById('e2')!;
    const Reveal = {
      getCurrentSlide: () => current,
      getIndices: (el: Element) => ({ h: el, v: 0 }),
      slide: (h: Element | number) => { current = typeof h === 'number' ? document.querySelector('.slides section')! : h; },
      sync: () => {},
      getConfig: () => ({ hash: true }),
    };
    new Function('Reveal', `${LANGUAGE_PICKER_PRE_INIT}\n${LANGUAGE_PICKER_POST_INIT}`)(Reveal);
    const toggle = document.getElementById('lang-toggle') as HTMLSelectElement;
    const pick = (lang: string) => { toggle.value = lang; toggle.dispatchEvent(new Event('change')); };

    pick('vi'); // e2 is the 2nd English slide → the 2nd Vietnamese slide, not the same slide number
    expect(current.id).toBe('v2');
    expect(location.search).toBe('?lang=vi');
    expect(location.hash).toBe('#/v2');

    pick('en');
    expect(current.id).toBe('e2');
    expect(location.hash).toBe('#/e2');

    current = document.getElementById('e2-img')!; // shared slides stay where they are
    pick('vi');
    expect(current.id).toBe('e2-img');
    expect(location.hash).toBe('#/e2-img');
    pick('en');
    expect(current.id).toBe('e2-img');
    expect(location.search).toBe('?lang=en');
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
