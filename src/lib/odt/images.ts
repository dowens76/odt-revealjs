const BROWSER_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/svg+xml',
  'image/webp',
  'image/bmp',
  'image/avif',
]);

const EXT_MIMES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  wmf: 'image/wmf',
  emf: 'image/emf',
  svm: 'image/x-svm',
};

function startsWith(data: Uint8Array, bytes: number[], offset = 0): boolean {
  return bytes.every((b, i) => data[offset + i] === b);
}

/** Identify an image by its magic bytes, falling back to the file extension. */
export function sniffImageMime(data: Uint8Array | null, path: string): string {
  if (data && data.length >= 12) {
    if (startsWith(data, [0x89, 0x50, 0x4e, 0x47])) return 'image/png';
    if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (startsWith(data, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
    if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && startsWith(data, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
    if (startsWith(data, [0x42, 0x4d])) return 'image/bmp';
    if (startsWith(data, [0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66], 4)) return 'image/avif';
    if (startsWith(data, [0x49, 0x49, 0x2a, 0x00]) || startsWith(data, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff';
    if (startsWith(data, [0xd7, 0xcd, 0xc6, 0x9a]) || startsWith(data, [0x01, 0x00, 0x09, 0x00])) return 'image/wmf';
    if (startsWith(data, [0x01, 0x00, 0x00, 0x00]) && startsWith(data, [0x20, 0x45, 0x4d, 0x46], 40)) return 'image/emf';
    if (startsWith(data, [0x56, 0x43, 0x4c, 0x4d, 0x54, 0x46])) return 'image/x-svm';
    const head = new TextDecoder().decode(data.subarray(0, 512));
    if (/<svg[\s>]/i.test(head)) return 'image/svg+xml';
  }
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  return EXT_MIMES[ext] ?? 'application/octet-stream';
}

export function isBrowserImage(mime: string): boolean {
  return BROWSER_MIMES.has(mime);
}

export function toDataUri(mime: string, data: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < data.length; i += chunk) {
    binary += String.fromCharCode(...data.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
