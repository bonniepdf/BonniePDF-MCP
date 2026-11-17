import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { Knowledge } from './types.js';

export const DATA_ROOT = fileURLToPath(new URL('../data/', import.meta.url));
export class KnowledgeBase {
  readonly data: Knowledge;
  readonly elements: Record<string, any>;
  constructor(readonly root = DATA_ROOT) {
    this.data = JSON.parse(readFileSync(resolve(root, 'knowledge.json'), 'utf8'));
    this.elements = JSON.parse(readFileSync(resolve(root, 'elements.json'), 'utf8'));
    if (this.data.format !== 1) throw new Error('Unsupported knowledge bundle format');
    const manifest=JSON.parse(readFileSync(resolve(root,'manifest.json'),'utf8')) as Record<string,string>;
    for(const [name,expected] of Object.entries(manifest)){
      const actual=createHash('sha256').update(this.file(name)).digest('hex');
      if(actual!==expected)throw new Error(`Knowledge file ${name} differs from its generated manifest. Regenerate the bundle.`);
    }
    const version = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@bonniepdf/core/package.json')), 'utf8')).version;
    if (version !== this.data.coreVersion) throw new Error(`Knowledge bundle is for core ${this.data.coreVersion}, installed ${version}. Regenerate it.`);
  }
  file(name: string): Buffer {
    if (!/^(?:definitions\/[a-z0-9-]+\.json|sources\/[a-z0-9-]+\.(?:ts|cs)|assets\/[a-f0-9]{64}|schema\.json|elements\.json|knowledge\.json)$/.test(name)) throw new Error('Unknown bundle resource');
    return readFileSync(resolve(this.root, name));
  }
  example(id: string) {
    const entry = this.data.examples.find(e => e.id === id);
    if (!entry) throw new Error(`Unknown example: ${id}`);
    return entry;
  }
  search(query: string, kind: 'examples'|'docs'|'all' = 'all', limit = 5, language?: string, editableOnly = false) {
    const terms = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const score = (title: string, body: string) => terms.reduce((s,t) => s + (title.toLowerCase().includes(t) ? 5 : 0) + (body.toLowerCase().includes(t) ? 1 : 0), 0);
    const results: { score:number; [key:string]: unknown }[] = [];
    if (kind !== 'docs') for (const e of this.data.examples) {
      if (editableOnly && !e.definition) continue;
      const s = score(`${e.id} ${e.name} ${e.documentType ?? ''} ${e.capabilities.join(' ')}`,`${e.description} ${e.industries.join(' ')}`);
      if (!terms.length || s) results.push({ score:s, kind:'example', id:e.id, title:e.name, description:e.description, editable:!!e.definition, capabilities:e.capabilities, languages:Object.keys(e.source) });
    }
    if (kind !== 'examples') for (const d of this.data.docs) {
      if (language && d.language !== language) continue;
      const s = score(d.title, d.text);
      if (!terms.length || s) results.push({ score:s, kind:'doc', id:d.id, title:d.title, language:d.language, url:d.url, excerpt:d.text.slice(0,280) });
    }
    const sorted = results.sort((a,b) => b.score-a.score || String(a.id).localeCompare(String(b.id)));
    return { total:sorted.length, results:sorted.slice(0,limit) };
  }
  describe(name: string) {
    const d = this.elements;
    const shape = d.elements?.[name] ?? d.shapes?.[name] ?? d.objects?.[name];
    if (!shape) return { availableElements:Object.keys(d.elements ?? {}), availableShapes:Object.keys(d.shapes ?? {}) };
    const keys = Object.assign({}, ...(shape.uses ?? []).map((use:string) => d.mixins[use]), shape.keys);
    const tokens: Record<string,unknown> = {};
    for (const value of Object.values(keys) as any[]) {
      if (value.kind?.startsWith('enum:')) { const enumName = value.kind.slice(5); tokens[enumName] = d.enums?.[enumName]; }
    }
    return { name, ...shape, keys, tokens, definitionVersion:this.data.definitionVersion };
  }
}
