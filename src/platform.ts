/**
 * Thin platform layer: uses Tauri APIs inside the desktop app and falls back to
 * standard browser APIs when the UI runs in a plain browser (`npm run dev`).
 */
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { open, save } from '@tauri-apps/plugin-dialog';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { parseTemplate, type Template } from './lib/templates';

export const isTauri = '__TAURI_INTERNALS__' in window;

export interface OpenedFile {
  name: string;
  path: string | null;
  bytes: Uint8Array;
}

export interface SavedFile {
  name: string;
  /** Full path on disk (desktop app only). */
  path: string | null;
}

const DOC_EXTENSIONS = ['odt', 'fodt', 'ott'];

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function isDocumentName(name: string): boolean {
  return DOC_EXTENSIONS.includes(name.split('.').pop()?.toLowerCase() ?? '');
}

export async function pickDocument(): Promise<OpenedFile | null> {
  if (isTauri) {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'OpenDocument Text', extensions: DOC_EXTENSIONS }],
    });
    return typeof path === 'string' ? readPath(path) : null;
  }
  const file = await pickBrowserFile('.odt,.fodt,.ott');
  return file ? { name: file.name, path: null, bytes: new Uint8Array(await file.arrayBuffer()) } : null;
}

export async function readPath(path: string): Promise<OpenedFile> {
  const buf = await invoke<ArrayBuffer>('read_binary', { path });
  return { name: basename(path), path, bytes: new Uint8Array(buf) };
}

export async function saveTextFile(
  defaultName: string,
  contents: string,
  filter: { name: string; extensions: string[] },
): Promise<SavedFile | null> {
  if (isTauri) {
    const path = await save({ defaultPath: defaultName, filters: [filter] });
    if (!path) return null;
    await invoke('write_text', { path, contents });
    return { name: basename(path), path };
  }
  const type = filter.extensions[0] === 'json' ? 'application/json' : 'text/html';
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: defaultName });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { name: defaultName, path: null };
}

export async function readTextFile(filter: { name: string; extensions: string[] }): Promise<string | null> {
  if (isTauri) {
    const path = await open({ multiple: false, directory: false, filters: [filter] });
    if (typeof path !== 'string') return null;
    return new TextDecoder().decode((await readPath(path)).bytes);
  }
  const file = await pickBrowserFile(filter.extensions.map((e) => `.${e}`).join(','));
  return file ? file.text() : null;
}

export async function copyText(text: string): Promise<void> {
  if (isTauri) await writeText(text);
  else await navigator.clipboard.writeText(text);
}

export async function openInDefaultApp(path: string): Promise<void> {
  if (isTauri) await openPath(path);
}

export async function showInFolder(path: string): Promise<void> {
  if (isTauri) await revealItemInDir(path);
}

const LOCAL_KEY = 'odt-reveal.templates';

export async function loadTemplates(): Promise<Template[]> {
  let raw = '[]';
  try {
    raw = isTauri ? await invoke<string>('load_templates') : (localStorage.getItem(LOCAL_KEY) ?? '[]');
  } catch (e) {
    console.error('Could not load templates', e);
  }
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.flatMap((t) => { try { return [parseTemplate(t)]; } catch { return []; } }) : [];
  } catch {
    return [];
  }
}

export async function saveTemplates(templates: Template[]): Promise<void> {
  const json = JSON.stringify(templates, null, 2);
  if (isTauri) await invoke('save_templates', { json });
  else localStorage.setItem(LOCAL_KEY, json);
}

/** Wire up drag-and-drop of documents onto the window. */
export async function onDocumentDrop(onHover: (active: boolean) => void, onDrop: (file: OpenedFile) => void, onError: (e: unknown) => void) {
  if (isTauri) {
    await getCurrentWebview().onDragDropEvent(async (event) => {
      const p = event.payload;
      if (p.type === 'enter' || p.type === 'over') onHover(true);
      else if (p.type === 'leave') onHover(false);
      else if (p.type === 'drop') {
        onHover(false);
        const path = p.paths.find(isDocumentName) ?? p.paths[0];
        if (path) {
          try {
            onDrop(await readPath(path));
          } catch (e) {
            onError(e);
          }
        }
      }
    });
    return;
  }
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; onHover(true); });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; onHover(false); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    onHover(false);
    const file = e.dataTransfer?.files[0];
    if (file) onDrop({ name: file.name, path: null, bytes: new Uint8Array(await file.arrayBuffer()) });
  });
}

function pickBrowserFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept });
    input.addEventListener('change', () => resolve(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
}
