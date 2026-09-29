import type { OdtDocument } from './model';
import { DEFAULT_PRESENTATION, type PresentationOptions } from './presentation';
import { DEFAULT_SETTINGS, type ConversionSettings, type ParagraphAction, type TextAction } from './render';

export type OutputMode = 'html' | 'presentation';

export interface OutputSettings {
  mode: OutputMode;
  presentation: Omit<PresentationOptions, 'title'>;
}

/**
 * A reusable set of choices. Sections are remembered by heading text (so a template
 * made from one report works on the next edition) with a per-level fallback for
 * headings the template has never seen.
 */
export interface Template {
  version: 1;
  name: string;
  savedAt: string;
  conversion: Omit<ConversionSettings, 'sections'> & {
    sectionsByTitle: Record<string, boolean>;
    levels: Record<string, boolean>;
  };
  output: OutputSettings;
}

export const DEFAULT_OUTPUT: OutputSettings = {
  mode: 'presentation',
  presentation: withoutTitle(DEFAULT_PRESENTATION),
};

export function createTemplate(
  name: string,
  doc: OdtDocument | null,
  settings: ConversionSettings,
  output: OutputSettings,
): Template {
  const sectionsByTitle: Record<string, boolean> = {};
  const levelState = new Map<number, { on: number; off: number }>();
  for (const s of doc?.sections ?? []) {
    const included = settings.sections[s.id] !== false;
    if (s.title) sectionsByTitle[s.title] = included;
    const l = levelState.get(s.level) ?? { on: 0, off: 0 };
    l[included ? 'on' : 'off']++;
    levelState.set(s.level, l);
  }
  // A level counts as excluded only when every section at that level was excluded.
  const levels: Record<string, boolean> = {};
  for (const [level, { on }] of levelState) levels[level] = on > 0;

  const { sections: _omit, ...rest } = settings;
  return {
    version: 1,
    name,
    savedAt: new Date().toISOString(),
    conversion: {
      ...rest,
      paragraphStyles: { ...settings.paragraphStyles },
      textStyles: { ...settings.textStyles },
      sectionsByTitle,
      levels,
    },
    output: structuredClone(output),
  };
}

export function applyTemplate(t: Template, doc: OdtDocument | null): { settings: ConversionSettings; output: OutputSettings } {
  const { sectionsByTitle, levels, ...conv } = t.conversion;
  const sections: Record<string, boolean> = {};
  for (const s of doc?.sections ?? []) {
    sections[s.id] = sectionsByTitle[s.title] ?? levels[s.level] ?? true;
  }
  return {
    settings: { ...DEFAULT_SETTINGS, ...conv, sections },
    output: {
      mode: t.output?.mode === 'html' ? 'html' : 'presentation',
      presentation: { ...DEFAULT_OUTPUT.presentation, ...t.output?.presentation },
    },
  };
}

/** Validate and normalise a template read from disk or imported by the user. */
export function parseTemplate(json: unknown): Template {
  const t = json as Partial<Template>;
  if (!t || typeof t !== 'object' || typeof t.name !== 'string' || !t.conversion || typeof t.conversion !== 'object') {
    throw new Error('This file is not an ODT to Reveal template.');
  }
  const c = t.conversion;
  return {
    version: 1,
    name: t.name,
    savedAt: typeof t.savedAt === 'string' ? t.savedAt : new Date().toISOString(),
    conversion: {
      ...withoutSections(DEFAULT_SETTINGS),
      ...c,
      paragraphStyles: pickActions(c.paragraphStyles, ['include', 'exclude', 'notes']) as Record<string, ParagraphAction>,
      textStyles: pickActions(c.textStyles, ['include', 'plain', 'exclude']) as Record<string, TextAction>,
      sectionsByTitle: pickBooleans(c.sectionsByTitle),
      levels: pickBooleans(c.levels),
    },
    output: {
      mode: t.output?.mode === 'html' ? 'html' : 'presentation',
      presentation: { ...DEFAULT_OUTPUT.presentation, ...(t.output?.presentation ?? {}) },
    },
  };
}

function pickActions(o: unknown, allowed: string[]): Record<string, string> {
  if (!o || typeof o !== 'object') return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => allowed.includes(v as string)));
}

function pickBooleans(o: unknown): Record<string, boolean> {
  if (!o || typeof o !== 'object') return {};
  return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'boolean'));
}

function withoutTitle({ title: _t, ...rest }: PresentationOptions): Omit<PresentationOptions, 'title'> {
  return rest;
}

function withoutSections({ sections: _s, ...rest }: ConversionSettings): Omit<ConversionSettings, 'sections'> {
  return rest;
}
