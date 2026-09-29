# ODT → Reveal.js

A small desktop app for macOS and Windows that turns an OpenDocument text file (`.odt` or `.fodt`) into a [reveal.js](https://revealjs.com) presentation. **Every heading in the document starts a new `<section>`, which becomes a new slide.**

- **Pick sections.** The document outline appears as a checklist. You can toggle a whole level at once (H1, H2, …). Unticking a heading also unticks its sub-headings. Click any title to jump to that slide in the live preview.
- **Pick styles.** Each paragraph style can be *included*, moved to *speaker notes*, or *excluded*. Each character style can be *kept*, made *plain* (keeps the text, drops the formatting) or *removed*. A sample line from the document is shown next to each style so you can see what it's used for.
- **Templates.** Save all your choices (sections, styles and output settings) as a named template and apply it to the next document. Sections are matched by heading text, with a fallback per heading level. Templates can be exported and imported as `.json` to share with colleagues.
- **Two kinds of output:**
  - **HTML sections**: just the `<section>` markup, copied to the clipboard or saved, for pasting into an existing deck.
  - **Complete presentation**: one `.html` file that works on its own, with these options: theme (all 14 reveal.js themes), base font size, heading size, uppercase headings, left or centred text, transition, slide numbers, progress bar, controls, vertical centring, scrollable long slides, scroll view, and custom CSS. reveal.js is either **embedded** (the file works offline) or loaded from a **CDN** (much smaller file).
- **Images and formulas are included.** See [docs/images.md](docs/images.md) for the feasibility study and the list of what is supported.
- Also converted:
  - lists (nested, and numbered or bulleted);
  - tables, including header rows and merged cells;
  - links;
  - bold, italic, underline, strikethrough, superscript and subscript;
  - footnotes, which go to speaker notes, to the bottom of the slide, or are dropped;
  - *Preformatted Text* → `<pre><code>`;
  - *Quotations* → `<blockquote>`;
  - *Title* / *Subtitle* → a title slide.
- **Optional vertical slides.** Lower-level headings can be nested under their top-level heading as reveal.js vertical stacks.

## Using it

1. **Open document…** (or <kbd>⌘/Ctrl</kbd>+<kbd>O</kbd>), or drag an `.odt` file onto the window.
2. Choose what to include on the **Sections** and **Styles** tabs.
3. Choose the output on the **Output** tab.
4. Click **Save presentation…** (<kbd>⌘/Ctrl</kbd>+<kbd>S</kbd>) or **Copy &lt;section&gt; HTML**.

Tip: create a paragraph style called **Speaker Notes** in LibreOffice for your presenter notes. The app sends that style to reveal.js speaker notes automatically. Press <kbd>S</kbd> during a presentation to open the speaker view.

## Development

You need Node 22+ and a Rust toolchain. See the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npm run tauri dev        # run the desktop app with hot reload
npm run dev              # run just the UI in a browser at http://localhost:1420
npm test                 # converter tests (vitest)
npm run tauri build      # build installers for the current OS
```

The UI also runs in a plain browser. In that mode `platform.ts` uses the browser's file picker, downloads and `localStorage` instead of the Tauri APIs.

### Releases

`.github/workflows/build.yml` runs the tests on every push. When you push a `v*` tag, it builds a universal macOS `.dmg` and a Windows `.exe`/`.msi` installer and attaches them to a draft GitHub release. You can also build these on demand with **Run workflow**.

The builds are not code-signed. On first launch:

- **macOS:** right-click the app → **Open**.
- **Windows:** in the SmartScreen prompt, click **More info** → **Run anyway**.

To sign the builds, add Apple Developer ID and Windows code-signing secrets as described in the Tauri docs.

### Architecture

```
src/
  lib/                     pure TypeScript, no UI; unit-tested
    odt/parse.ts           ODT/FODT → document model (sections, blocks, inlines, images, style usage)
    odt/styles.ts          style registry: resolves automatic styles (P1, T3…) to named styles
    odt/images.ts          format sniffing, data URIs
    render.ts              model + choices → <section> HTML
    presentation.ts        <section> HTML + options → complete reveal.js document
    reveal-assets.ts       bundled reveal.js files (themes loaded on demand)
    templates.ts           save / apply / validate templates
  platform.ts              Tauri ↔ browser abstraction (dialogs, files, clipboard, template storage)
  main.ts                  UI
src-tauri/                 Rust shell: 4 small commands (read file, write file, load/save templates)
```

**Why Tauri?** It uses the operating system's own web view, so the installer is about 5–10 MB instead of the ~150 MB an Electron app needs. The conversion code is plain TypeScript with two runtime dependencies: `fflate` for unzipping and `reveal.js`.

**Security.** Document content is escaped. Links are limited to `http(s)`, `mailto` and `ftp`. MathML from formulas is rebuilt from an allowlist. The live preview runs in a sandboxed `<iframe>` without same-origin access.

## Limitations

- Only headings (`text:h`, i.e. *Heading 1–10* and custom styles with an outline level) start slides. A paragraph formatted by hand to look like a heading does not.
- Tables of contents, indexes, comments and tracked changes are skipped.
- Page layout (columns, frames, image wrapping) has no equivalent on slides.
- A long section becomes one long slide. Turn on *Scroll long slides*, reduce the font size, or add more headings in the source document.
