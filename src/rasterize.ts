import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAsync } from '@resvg/resvg-js';

export const MAX_PREVIEW_WIDTH = 2000;
export const MAX_PREVIEW_HEIGHT = 3000;

const FONT_DIR = resolve(dirname(fileURLToPath(import.meta.resolve('@bonniepdf/core/package.json'))), 'assets/fonts');
const LIBERATION = ['Sans', 'Serif', 'Mono'].flatMap(family =>
  ['Regular', 'Bold', 'Italic', 'BoldItalic'].map(face => resolve(FONT_DIR, `Liberation${family}-${face}.ttf`))
);

/**
 * Rasterises BonniePDF page SVGs without a browser.
 *
 * The exporter embeds each used face as an `@font-face` subset under a private
 * `bpf-…` family. resvg does not read CSS fonts and matches faces by the family in
 * their `name` table, so each subset is renamed to its private family and loaded
 * from a temporary file. Standard-14 stacks fall back to the metric-compatible
 * Liberation faces. System fonts are never consulted, so output is reproducible.
 */
export async function rasterizeSvgPages(
  svgs: readonly string[],
  fontFaceCss: string,
  options: { scale?: number; signal?: AbortSignal } = {}
): Promise<Buffer[]> {
  const scale = options.scale ?? 1;
  const faces = parseFontFaces(fontFaceCss);
  const dir = faces.length ? await mkdtemp(resolve(tmpdir(), 'bonniepdf-fonts-')) : undefined;
  try {
    const fontFiles = [...LIBERATION];
    for (const [i, face] of faces.entries()) {
      const path = resolve(dir!, `face-${i}.ttf`);
      await writeFile(path, renameFont(face.bytes, face.family));
      fontFiles.push(path);
    }
    const pngs: Buffer[] = [];
    for (const svg of svgs) {
      if (options.signal?.aborted) throw new Error('Preview cancelled');
      const { width, height } = svgSize(svg);
      if (Math.ceil(width * scale) > MAX_PREVIEW_WIDTH || Math.ceil(height * scale) > MAX_PREVIEW_HEIGHT) {
        throw new Error(`Preview dimensions exceed ${MAX_PREVIEW_WIDTH} × ${MAX_PREVIEW_HEIGHT} pixels`);
      }
      const image = await renderAsync(
        stripExternalReferences(svg),
        {
          background: 'white',
          fitTo: { mode: 'zoom', value: scale },
          font: {
            loadSystemFonts: false,
            fontFiles,
            defaultFontFamily: 'Liberation Sans',
            sansSerifFamily: 'Liberation Sans',
            serifFamily: 'Liberation Serif',
            monospaceFamily: 'Liberation Mono',
          },
          logLevel: 'off',
        },
        options.signal
      );
      pngs.push(image.asPng());
    }
    return pngs;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

export function parseFontFaces(css: string) {
  const faces: { family: string; bytes: Buffer }[] = [];
  const rule = /@font-face\{font-family:'([^']+)';[^}]*?src:url\("data:font\/[a-z0-9+.-]+;base64,([A-Za-z0-9+/=]+)"\)/g;
  for (const match of css.matchAll(rule)) faces.push({ family: match[1], bytes: Buffer.from(match[2], 'base64') });
  return faces;
}

/** A preview must never read a file or URL referenced by document content. */
export function stripExternalReferences(svg: string) {
  return svg.replace(/\s(?:xlink:)?href\s*=\s*("([^"]*)"|'([^']*)')/g, (attr, _quoted, dq, sq) => {
    const value = (dq ?? sq ?? '').trim();
    return value.startsWith('data:') || value.startsWith('#') ? attr : '';
  });
}

function svgSize(svg: string) {
  const root = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
  const width = Number(/\swidth="([\d.]+)"/.exec(root)?.[1]);
  const height = Number(/\sheight="([\d.]+)"/.exec(root)?.[1]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error('Page SVG has no numeric size');
  return { width, height };
}

/** Returns a copy of an sfnt font whose `name` table identifies it as `family`. */
export function renameFont(font: Uint8Array, family: string): Buffer {
  const src = Buffer.from(font.buffer, font.byteOffset, font.byteLength);
  const numTables = src.readUInt16BE(4);
  const tables = new Map<string, Buffer>();
  for (let i = 0; i < numTables; i++) {
    const entry = 12 + i * 16;
    const tag = src.toString('latin1', entry, entry + 4);
    const offset = src.readUInt32BE(entry + 8);
    const length = src.readUInt32BE(entry + 12);
    tables.set(tag, src.subarray(offset, offset + length));
  }
  tables.set('name', nameTable(family));
  const tags = [...tables.keys()].sort();
  const header = Buffer.alloc(12 + tags.length * 16);
  src.copy(header, 0, 0, 4);
  let pow = 1;
  while (pow * 2 <= tags.length) pow *= 2;
  header.writeUInt16BE(tags.length, 4);
  header.writeUInt16BE(pow * 16, 6);
  header.writeUInt16BE(Math.log2(pow), 8);
  header.writeUInt16BE(tags.length * 16 - pow * 16, 10);
  const bodies: Buffer[] = [];
  let offset = header.length;
  for (const [i, tag] of tags.entries()) {
    const data = tables.get(tag)!;
    const entry = 12 + i * 16;
    header.write(tag, entry, 'latin1');
    header.writeUInt32BE(checksum(data), entry + 4);
    header.writeUInt32BE(offset, entry + 8);
    header.writeUInt32BE(data.length, entry + 12);
    const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4);
    data.copy(padded);
    bodies.push(padded);
    offset += padded.length;
  }
  return Buffer.concat([header, ...bodies]);
}

function nameTable(family: string) {
  const strings: [number, string][] = [
    [1, family],
    [2, 'Regular'],
    [4, family],
    [6, family.replace(/[^A-Za-z0-9-]/g, '')],
    [16, family],
    [17, 'Regular'],
  ];
  const encoded = strings.map(([id, text]) => [id, Buffer.from(text, 'utf16le').swap16()] as const);
  const header = Buffer.alloc(6 + encoded.length * 12);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(encoded.length, 2);
  header.writeUInt16BE(header.length, 4);
  let offset = 0;
  for (const [i, [id, bytes]] of encoded.entries()) {
    const record = 6 + i * 12;
    header.writeUInt16BE(3, record); // Windows
    header.writeUInt16BE(1, record + 2); // Unicode BMP
    header.writeUInt16BE(0x409, record + 4); // en-US
    header.writeUInt16BE(id, record + 6);
    header.writeUInt16BE(bytes.length, record + 8);
    header.writeUInt16BE(offset, record + 10);
    offset += bytes.length;
  }
  return Buffer.concat([header, ...encoded.map(([, bytes]) => bytes)]);
}

function checksum(data: Buffer) {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const word = (data[i] << 24) | ((data[i + 1] ?? 0) << 16) | ((data[i + 2] ?? 0) << 8) | (data[i + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}
