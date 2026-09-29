# Images in ODT → reveal.js: feasibility

**Short answer: images are feasible, and the app already includes them.** Ordinary pictures (PNG, JPEG, GIF, SVG, WebP, BMP) come through reliably. Formulas work too, as MathML. The things that don't come through are a few legacy vector formats, charts and other OLE objects, linked (not embedded) files, and page layout.

## How ODT stores images

An `.odt` file is a zip archive. Embedded pictures are stored as files under `Pictures/`, and `content.xml` points to them from a frame:

```xml
<text:p text:style-name="Text_20_body">
  <draw:frame draw:name="Image1" text:anchor-type="as-char" svg:width="16.51cm" svg:height="9.2cm">
    <draw:image xlink:href="Pictures/1000000000000500000002D0C2645DE.png"/>
    <svg:title>Alt text</svg:title>
  </draw:frame>
</text:p>
```

| Piece | Where it lives | What the converter does with it |
| --- | --- | --- |
| Image bytes | `Pictures/*` in the zip. Flat `.fodt` files use base64 in `<office:binary-data>` instead. | Reads the bytes and identifies the format by its magic bytes, not the file extension. |
| Display size | `svg:width` / `svg:height` on `draw:frame` | Converts to CSS pixels at 96 dpi and emits `style="width: …px"`. CSS caps the image at the slide size. |
| Alt text | `svg:title` / `svg:desc` on the frame | Emits it as `alt="…"`. |
| Captions | The image frame sits inside a `draw:text-box` in an outer frame | Renders the image followed by the caption text. |
| Multiple renditions | Several `draw:image` children, e.g. SVG plus a PNG fallback | Picks the first one a browser can display. |
| Formulas | `draw:object` → `Object N/content.xml` (MathML) | Inlines it as `<math>` after running it through an allowlist sanitizer. |

In the output the images are embedded as `data:` URIs, which gives two benefits:

- the saved presentation is one self-contained file;
- the "copy HTML" output keeps working when pasted into another deck.

## What works and what doesn't

| Content | Status | Notes |
| --- | --- | --- |
| PNG, JPEG, GIF, WebP, BMP, AVIF | ✅ Supported | |
| SVG | ✅ Supported | |
| Formulas (LibreOffice Math) | ✅ Supported | Rendered as native MathML. That needs Safari, Firefox or Chrome/Edge 109+. |
| Images with captions | ✅ Supported | The caption follows the image; figure numbering is kept as plain text. |
| Images linked from `http(s)` URLs | ✅ Kept as a URL | The presentation needs internet access to show them. |
| TIFF | ⚠️ Skipped, with a warning | Safari can display TIFF but Chrome, Edge and Firefox can't, so the output wouldn't be portable. |
| WMF / EMF (common in files from Word, and in clip art) | ⚠️ Skipped, with a warning | Browsers can't render these formats. |
| Charts, embedded spreadsheets and other OLE objects | ⚠️ Skipped, with a warning | LibreOffice stores their preview image as SVM, a LibreOffice-only metafile format. |
| Images linked to local files (not embedded) | ⚠️ Skipped, with a warning | The file isn't inside the `.odt`. |
| Drawing shapes (lines, arrows, callouts, shape groups) | ⚠️ Skipped, with a warning | They are vector drawing commands, not images. |
| Position, text wrap, cropping, rotation, borders | ❌ Not carried over | Slides don't share the page layout model. Images become inline, block-level content. |

The app lists every skipped item in the **⚠ notes** panel above the preview, so nothing disappears silently.

## Trade-offs

- **File size.** Base64 makes images about 33% larger. A deck with many large photos gets a big HTML file. In practice this is only a problem for photo-heavy documents.
- **Sizing.** A figure that is 16 cm wide in the document is about 620 px, which is about two-thirds of a 960 px slide. That usually looks right. Images are also capped at `max-height: 520px` so a tall figure can't push the rest of the slide out of view.

## Options for closing the gaps

In rough order of value against effort:

1. **Convert WMF/EMF/SVM/TIFF through LibreOffice.** When LibreOffice is installed, run `soffice --headless --convert-to png` (or `svg`) on the extracted file. This covers charts, clip art and TIFF. It is optional: without LibreOffice the app behaves as it does now. On the Tauri side it only needs a `Command` call.
2. **Folder export.** Write `presentation.html` plus an `images/` folder instead of data URIs. This gives smaller HTML that is easier to edit by hand. The renderer already goes through an `imageSrc()` callback, so this only needs a new callback and a save-to-directory dialog.
3. **Downscale large photos** (for example to a maximum of 1920 px) with a canvas before embedding. This cuts file size a lot for camera images.
4. **Resolve local linked images** relative to the `.odt` file's own folder. The desktop app has the path, so this is simple.
5. **Rendering drawing shapes** is not worth doing. Users can group shapes and use *Convert → To Bitmap* in LibreOffice instead.
