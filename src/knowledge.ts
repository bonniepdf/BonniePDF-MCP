import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { Knowledge, ExampleEntry, DocEntry } from './types.js';

export const DATA_ROOT = fileURLToPath(new URL('../data/', import.meta.url));
const BUNDLE_FILE =
  /^(?:definitions\/[a-z0-9-]+\.json|sources\/[a-z0-9-]+\.(?:ts|cs)|assets\/[a-f0-9]{64}|fonts\/[A-Za-z0-9-]+\.(?:ttf|otf|txt)|schema\.json|elements\.json|knowledge\.json)$/;

/** Lower-cases, splits on non-alphanumerics and folds simple plurals ("tables" → "table"). */
export function tokenize(text: string) {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).map(t =>
    t.length > 3 && t.endsWith('ies')
      ? t.slice(0, -3) + 'y'
      : t.length > 3 && t.endsWith('s') && !t.endsWith('ss')
        ? t.slice(0, -1)
        : t
  );
}

interface Indexed<T> {
  item: T;
  /** Weighted field term frequencies: title terms count more than body terms. */
  tf: Map<string, number>;
  length: number;
}

/** A small BM25 index. The catalogue is a few hundred entries, so it is built once in memory. */
class Bm25<T> {
  private readonly docs: Indexed<T>[];
  private readonly df = new Map<string, number>();
  private readonly avgLength: number;
  constructor(items: readonly T[], fields: (item: T) => [text: string, weight: number][]) {
    this.docs = items.map(item => {
      const tf = new Map<string, number>();
      let length = 0;
      for (const [text, weight] of fields(item)) {
        for (const term of tokenize(text)) {
          tf.set(term, (tf.get(term) ?? 0) + weight);
          length += weight;
        }
      }
      for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
      return { item, tf, length };
    });
    this.avgLength = this.docs.reduce((n, d) => n + d.length, 0) / Math.max(1, this.docs.length);
  }
  search(terms: string[], filter: (item: T) => boolean = () => true) {
    const k1 = 1.2;
    const b = 0.75;
    const n = this.docs.length;
    const results: { item: T; score: number }[] = [];
    for (const doc of this.docs) {
      if (!filter(doc.item)) continue;
      let score = 0;
      for (const term of terms) {
        const tf = doc.tf.get(term);
        if (!tf) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * doc.length) / this.avgLength));
      }
      if (!terms.length || score > 0) results.push({ item: doc.item, score: Math.round(score * 100) / 100 });
    }
    return results;
  }
}

/** Returns about `size` characters of `text` around the first query term, on word boundaries. */
export function excerptAround(text: string, terms: string[], size = 280) {
  const lower = text.toLowerCase();
  const hit = terms.map(t => lower.indexOf(t)).filter(i => i >= 0);
  if (!hit.length || Math.min(...hit) < size / 2) return text.slice(0, size).trim() + (text.length > size ? '…' : '');
  let start = Math.max(0, Math.min(...hit) - Math.floor(size / 3));
  const space = text.indexOf(' ', start);
  if (space >= 0 && space - start < 30) start = space + 1;
  return '…' + text.slice(start, start + size).trim() + (start + size < text.length ? '…' : '');
}

export class KnowledgeBase {
  readonly data: Knowledge;
  readonly elements: Record<string, any>;
  readonly schema: Record<string, any>;
  private readonly exampleIndex: Bm25<ExampleEntry>;
  private readonly docIndex: Bm25<DocEntry>;

  constructor(readonly root = DATA_ROOT) {
    if (!existsSync(resolve(root, 'knowledge.json')))
      throw new Error(
        'Generated knowledge bundle is missing. Run pnpm mcp:build from the workspace root, or reinstall the packaged server.'
      );
    this.data = JSON.parse(readFileSync(resolve(root, 'knowledge.json'), 'utf8'));
    this.elements = JSON.parse(readFileSync(resolve(root, 'elements.json'), 'utf8'));
    this.schema = JSON.parse(readFileSync(resolve(root, 'schema.json'), 'utf8'));
    if (this.data.format !== 1) throw new Error('Unsupported knowledge bundle format');
    const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')) as Record<string, string>;
    for (const [name, expected] of Object.entries(manifest)) {
      const actual = createHash('sha256').update(this.file(name)).digest('hex');
      if (actual !== expected)
        throw new Error(`Knowledge file ${name} differs from its generated manifest. Regenerate the bundle.`);
    }
    const version = JSON.parse(
      readFileSync(fileURLToPath(import.meta.resolve('@bonniepdf/core/package.json')), 'utf8')
    ).version;
    if (version !== this.data.coreVersion) {
      throw new Error(`Knowledge bundle is for core ${this.data.coreVersion}, installed ${version}. Regenerate it.`);
    }
    this.exampleIndex = new Bm25(this.data.examples, e => [
      [`${e.id} ${e.name}`, 3],
      [`${e.documentType ?? ''} ${e.capabilities.join(' ')} ${e.category}`, 2],
      [`${e.description} ${e.industries.join(' ')}`, 1],
    ]);
    this.docIndex = new Bm25(this.data.docs, d => [
      [`${d.title} ${d.id}`, 3],
      [d.text, 1],
    ]);
  }

  file(name: string): Buffer {
    if (!BUNDLE_FILE.test(name)) throw new Error('Unknown bundle resource');
    return readFileSync(resolve(this.root, name));
  }

  example(id: string) {
    const entry = this.data.examples.find(e => e.id === id);
    if (!entry) {
      const near = this.search(id.replace(/-/g, ' '), 'examples', 3).results.map(r => r.id);
      throw new Error(`Unknown example: ${id}.${near.length ? ` Did you mean ${near.join(', ')}?` : ''}`);
    }
    return entry;
  }

  search(query: string, kind: 'examples' | 'docs' | 'all' = 'all', limit = 5, language?: string, editableOnly = false) {
    const terms = [...new Set(tokenize(query))];
    const results: { score: number; [key: string]: unknown }[] = [];
    if (kind !== 'docs') {
      for (const { item: e, score } of this.exampleIndex.search(terms, e => !editableOnly || !!e.definition)) {
        results.push({
          score,
          kind: 'example',
          id: e.id,
          title: e.name,
          description: e.description,
          editable: !!e.definition,
          capabilities: e.capabilities,
          languages: Object.keys(e.source),
        });
      }
    }
    if (kind !== 'examples') {
      for (const { item: d, score } of this.docIndex.search(terms, d => !language || d.language === language)) {
        results.push({
          score,
          kind: 'doc',
          id: d.id,
          title: d.title,
          language: d.language,
          url: d.url,
          excerpt: excerptAround(d.text, terms),
        });
      }
    }
    const sorted = results.sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)));
    return { total: sorted.length, results: sorted.slice(0, limit) };
  }

  describe(name: string, property?: string) {
    const d = this.elements;
    const shape = d.elements?.[name] ?? d.shapes?.[name] ?? d.objects?.[name];
    const schema = Object.hasOwn(this.schema.$defs, name) ? this.schema.$defs[name] : undefined;
    if (property !== undefined) {
      const field = Object.hasOwn(schema?.properties ?? {}, property) ? schema.properties[property] : undefined;
      if (!field) throw new Error(`Unknown property: ${name}.${property}. Use describe_element({name}) to list keys.`);
      const resolved =
        field.$ref?.startsWith('#/$defs/') && field.$ref !== '#/$defs/Element'
          ? (this.schema.$defs[field.$ref.slice('#/$defs/'.length)] ?? field)
          : field;
      const refs = [
        ...new Set<string>([...JSON.stringify(resolved).matchAll(/"\$ref":"#\/\$defs\/([^"/]+)"/g)].map(m => m[1])),
      ];
      // Keep recursive element unions out of focused responses. Their concrete
      // types are discoverable separately, without retransmitting the catalogue.
      const definitions = Object.fromEntries(
        refs.filter(ref => ref !== 'Element').map(ref => [ref, this.schema.$defs[ref]])
      );
      return {
        name,
        property,
        required: schema.required?.includes(property) ?? false,
        schema: resolved,
        ...(Object.keys(definitions).length ? { $defs: definitions } : {}),
        ...(refs.includes('Element')
          ? { elementHint: 'Use describe_element({name}) for the concrete element type.' }
          : {}),
        definitionVersion: this.data.definitionVersion,
      };
    }
    if (!shape && schema) return { name, schema, definitionVersion: this.data.definitionVersion };
    if (!shape) {
      const all = [...Object.keys(d.elements ?? {}), ...Object.keys(d.shapes ?? {}), ...Object.keys(d.objects ?? {})];
      const near = name
        ? all.filter(n => n.toLowerCase() === name.toLowerCase() || n.toLowerCase().includes(name.toLowerCase()))
        : [];
      return {
        ...(name ? { error: `Unknown element or shape: ${name}`, didYouMean: near.slice(0, 5) } : {}),
        availableElements: Object.keys(d.elements ?? {}),
        availableShapes: Object.keys(d.shapes ?? {}),
        availableObjects: Object.keys(d.objects ?? {}),
        availableValueTypes: Object.keys(this.schema.$defs ?? {}).filter(n => !all.includes(n) && n !== 'Element'),
      };
    }
    const keys = Object.assign({}, ...(shape.uses ?? []).map((use: string) => d.mixins[use]), shape.keys);
    const tokens: Record<string, unknown> = {};
    for (const value of Object.values(keys) as any[]) {
      if (value.kind?.startsWith('enum:')) {
        const enumName = value.kind.slice(5);
        tokens[enumName] = d.enums?.[enumName];
      }
    }
    const propertyTypes = Object.fromEntries(
      Object.entries(schema?.properties ?? {}).flatMap(([key, value]: [string, any]) =>
        value.$ref?.startsWith('#/$defs/') ? [[key, value.$ref.slice('#/$defs/'.length)]] : []
      )
    );
    if (Object.values(propertyTypes).includes('PageSize')) {
      tokens.PageSize = { tokens: this.schema.$defs.PageSize.oneOf.find((v: any) => v.enum)?.enum };
    }
    return { name, ...shape, keys, tokens, propertyTypes, definitionVersion: this.data.definitionVersion };
  }
}
