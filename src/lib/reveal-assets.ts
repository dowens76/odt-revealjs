import revealCss from 'reveal.js/reveal.css?raw';
import revealJs from '/node_modules/reveal.js/dist/reveal.js?raw';
import notesJs from '/node_modules/reveal.js/dist/plugin/notes.js?raw';
import type { RevealAssets, ThemeId } from './presentation';

// Themes are large (some embed their fonts), so each is loaded on demand.
const themes = import.meta.glob<string>('/node_modules/reveal.js/dist/theme/*.css', { query: '?raw', import: 'default' });

const cache = new Map<string, string>();

export async function loadThemeCss(theme: ThemeId): Promise<string> {
  const hit = cache.get(theme);
  if (hit) return hit;
  const loader = themes[`/node_modules/reveal.js/dist/theme/${theme}.css`];
  if (!loader) throw new Error(`Unknown theme: ${theme}`);
  const css = await loader();
  cache.set(theme, css);
  return css;
}

export async function loadRevealAssets(theme: ThemeId): Promise<RevealAssets> {
  return { revealCss, revealJs, notesJs, themeCss: await loadThemeCss(theme) };
}
