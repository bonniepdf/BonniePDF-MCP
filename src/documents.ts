import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateDefinition, type DocumentDefinition } from '@bonniepdf/core/definition';

export const LIMITS = {
  inputBytes: 2_000_000,
  elementNodes: 5000,
  elementDepth: 24,
  pages: 100,
  stringLength: 100_000,
  arrayLength: 10_000,
  resourceBytes: 8_000_000,
  resourceBytesTotal: 16_000_000,
  chartDataPoints: 10_000,
};
const MAX_DOCUMENTS = 50;
const MAX_STORED_BYTES = 32_000_000;
const SHOWN_ISSUES = 25;

export function validate(input: unknown) {
  return validateDefinition(input, { strict: true, limits: LIMITS });
}

/** The bounded form of a validation failure returned to the caller. */
function invalid(result: ReturnType<typeof validate>, revision?: number) {
  return {
    valid: false as const,
    ...(revision === undefined ? {} : { revision }),
    errors: result.errors.slice(0, SHOWN_ISSUES),
    warnings: result.warnings.slice(0, SHOWN_ISSUES),
    errorCount: result.errors.length,
    warningCount: result.warnings.length,
  };
}

const escapeKey = (key: string) => key.replaceAll('~', '~0').replaceAll('/', '~1');

export interface ElementNode {
  id: string;
  type: string;
  pointer: string;
  text?: string;
}

/** A short human-readable label for an element: its text, spans, title or alt text. */
function textOf(node: any): string | undefined {
  const text =
    typeof node.text === 'string'
      ? node.text
      : Array.isArray(node.spans)
        ? node.spans.map((s: any) => (typeof s === 'string' ? s : (s?.text ?? ''))).join('')
        : (node.title ?? node.altText ?? (typeof node.value === 'string' ? node.value : undefined));
  return typeof text === 'string' && text ? text : undefined;
}

/** Every element (any object with a string `type`) in document order, with its JSON Pointer. */
export function elements(definition: unknown): ElementNode[] {
  const nodes: ElementNode[] = [];
  const walk = (value: any, pointer: string) => {
    if (!value || typeof value !== 'object') return;
    if (typeof value.type === 'string') {
      const text = textOf(value);
      nodes.push({ id: value.id, type: value.type, pointer, ...(text ? { text: text.length > 60 ? text.slice(0, 57) + '…' : text } : {}) });
    }
    for (const [key, child] of Object.entries(value)) walk(child, `${pointer}/${escapeKey(key)}`);
  };
  walk(definition, '');
  return nodes;
}

export function summary(definition: DocumentDefinition) {
  const nodes = elements(definition);
  return {
    logicalPages: definition.pages.length,
    elements: nodes.length,
    outline: nodes.slice(0, SHOWN_ISSUES),
    outlineTruncated: nodes.length > SHOWN_ISSUES,
    ...(nodes.length > SHOWN_ISSUES ? { hint: 'Use find_elements to locate other elements by text, type or ID.' } : {}),
  };
}

function assignIds(definition: any) {
  const existing = new Set<string>();
  const collect = (v: any) => {
    if (!v || typeof v !== 'object') return;
    if (typeof v.id === 'string') existing.add(v.id);
    Object.values(v).forEach(collect);
  };
  collect(definition);
  let i = 1;
  const visit = (v: any) => {
    if (!v || typeof v !== 'object') return;
    if (typeof v.type === 'string' && !v.id) {
      while (existing.has(`mcp-${i}`)) i++;
      v.id = `mcp-${i++}`;
      existing.add(v.id);
    }
    Object.values(v).forEach(visit);
  };
  visit(definition);
}

export interface Session {
  definition: DocumentDefinition;
  revision: number;
  bytes: number;
}
export interface Patch {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: unknown;
  from?: string;
}
export interface FindQuery {
  text?: string;
  type?: string;
  id?: string;
  limit?: number;
}

/**
 * Session documents, keyed by handle. With a `persistDir`, every committed revision
 * is also written to disk, so handles survive a server restart.
 */
export class DocumentStore {
  private readonly documents = new Map<string, Session>();

  constructor(private readonly persistDir?: string) {
    if (!persistDir) return;
    mkdirSync(persistDir, { recursive: true });
    for (const name of readdirSync(persistDir)) {
      const id = name.replace(/\.json$/, '');
      if (!/^[0-9a-f-]{36}$/.test(id) || this.documents.size >= MAX_DOCUMENTS) continue;
      try {
        const saved = JSON.parse(readFileSync(resolve(persistDir, name), 'utf8'));
        const checked = validate(saved.definition);
        if (!checked.valid || !Number.isInteger(saved.revision)) continue;
        const bytes = Buffer.byteLength(JSON.stringify(saved.definition));
        if (this.totalBytes() + bytes > MAX_STORED_BYTES) continue;
        this.documents.set(id, { definition: saved.definition, revision: saved.revision, bytes });
      } catch (error) {
        console.error(`Skipped saved document ${name}: ${(error as Error).message}`);
      }
    }
  }

  private totalBytes() {
    return [...this.documents.values()].reduce((n, s) => n + s.bytes, 0);
  }

  private persist(id: string) {
    if (!this.persistDir) return;
    const doc = this.documents.get(id);
    const path = resolve(this.persistDir, `${id}.json`);
    if (!doc) {
      rmSync(path, { force: true });
      return;
    }
    // Write then rename, so a crash never leaves a half-written document.
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ revision: doc.revision, savedAt: new Date().toISOString(), definition: doc.definition }));
    renameSync(temp, path);
  }

  list() {
    return [...this.documents].map(([documentId, s]) => ({
      documentId,
      revision: s.revision,
      title: (s.definition as any).metadata?.title,
      bytes: s.bytes,
    }));
  }

  create(input: unknown) {
    const valid = validate(input);
    if (!valid.valid) return invalid(valid);
    const definition = structuredClone(valid.definition!);
    assignIds(definition);
    const withIds = validate(definition);
    if (!withIds.valid) return invalid(withIds);
    const bytes = Buffer.byteLength(JSON.stringify(definition));
    if (this.documents.size >= MAX_DOCUMENTS || this.totalBytes() + bytes > MAX_STORED_BYTES) {
      throw new Error('Session capacity reached. Delete an unused document.');
    }
    const documentId = randomUUID();
    this.documents.set(documentId, { definition, revision: 1, bytes });
    this.persist(documentId);
    return { valid: true, documentId, revision: 1, ...summary(definition) };
  }

  get(id: string) {
    const doc = this.documents.get(id);
    if (!doc) throw new Error('Unknown document handle. Use list_documents to see open handles.');
    return doc;
  }

  delete(id: string) {
    this.get(id);
    this.documents.delete(id);
    this.persist(id);
    return { deleted: true };
  }

  read(id: string, pointer = '') {
    const doc = this.get(id);
    const resolved = resolvePointer(doc.definition, pointer);
    return { documentId: id, revision: doc.revision, pointer: resolved, value: structuredClone(pointerValue(doc.definition, resolved)) };
  }

  find(id: string, query: FindQuery) {
    const doc = this.get(id);
    const text = query.text?.toLowerCase();
    const type = query.type?.toLowerCase();
    const matches = elements(doc.definition).filter((node) => {
      if (query.id && node.id !== query.id) return false;
      if (type && node.type.toLowerCase() !== type) return false;
      if (text) {
        const full = textOf(pointerValue(doc.definition, node.pointer));
        if (!full?.toLowerCase().includes(text)) return false;
      }
      return true;
    });
    const limit = query.limit ?? 20;
    return { documentId: id, revision: doc.revision, total: matches.length, matches: matches.slice(0, limit), truncated: matches.length > limit };
  }

  patch(id: string, revision: number, operations: Patch[]) {
    const current = this.get(id);
    if (current.revision !== revision) {
      throw new Error(`Revision conflict: expected ${revision}, current ${current.revision}. Re-read with get_document and retry.`);
    }
    const candidate = structuredClone(current.definition);
    for (const [i, op] of operations.entries()) {
      try {
        applyPatch(candidate, op);
      } catch (error) {
        throw new Error(`Operation ${i} (${op.op} ${op.path}): ${(error as Error).message}. No operations were applied.`);
      }
    }
    assignIds(candidate);
    const checked = validate(candidate);
    if (!checked.valid) return invalid(checked, current.revision);
    const bytes = Buffer.byteLength(JSON.stringify(candidate));
    if (this.totalBytes() - current.bytes + bytes > MAX_STORED_BYTES) throw new Error('Session capacity reached');
    this.documents.set(id, { definition: candidate, revision: revision + 1, bytes });
    this.persist(id);
    const { elements: count, logicalPages } = summary(candidate);
    return { valid: true, documentId: id, revision: revision + 1, elements: count, logicalPages };
  }
}

function parts(pointer: string) {
  if (pointer === '') return [];
  if (!pointer.startsWith('/') || /~(?![01])/u.test(pointer)) throw new Error('Expected an RFC 6901 JSON Pointer or #elementId/…');
  const keys = pointer
    .slice(1)
    .split('/')
    .map((k) => k.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (keys.some((k) => ['__proto__', 'prototype', 'constructor'].includes(k))) throw new Error('Unsafe pointer key');
  return keys;
}

/**
 * Expands `#elementId` or `#elementId/rest` to the element's JSON Pointer, so a caller
 * can address an element found by ID without knowing where it sits in the tree.
 */
export function resolvePointer(root: unknown, pointer: string) {
  if (!pointer.startsWith('#')) return pointer;
  const slash = pointer.indexOf('/');
  const id = slash < 0 ? pointer.slice(1) : pointer.slice(1, slash);
  const rest = slash < 0 ? '' : pointer.slice(slash);
  const found = elements(root).filter((n) => n.id === id);
  if (!found.length) throw new Error(`No element has id '${id}'`);
  if (found.length > 1) throw new Error(`Element id '${id}' is not unique; use a JSON Pointer`);
  return found[0].pointer + rest;
}

function index(key: string, length: number, append = false) {
  if (append && key === '-') return length;
  if (!/^(0|[1-9][0-9]*)$/.test(key)) throw new Error('Invalid array index');
  const n = Number(key);
  if (n > length || (!append && n === length)) throw new Error('Array index out of bounds');
  return n;
}

export function pointerValue(root: any, pointer: string) {
  let value = root;
  for (const key of parts(pointer)) {
    if (!value || typeof value !== 'object') throw new Error('Pointer does not exist');
    const k = Array.isArray(value) ? index(key, value.length) : key;
    if (!Object.hasOwn(value, k)) throw new Error('Pointer does not exist');
    value = value[k];
  }
  return value;
}

function locate(root: any, pointer: string) {
  const keys = parts(pointer);
  const key = keys.pop();
  if (key === undefined) throw new Error('Root replacement is not supported; create a new document');
  const parent = pointerValue(root, keys.length ? '/' + keys.map(escapeKey).join('/') : '');
  if (!parent || typeof parent !== 'object') throw new Error('Patch parent is not an object');
  return { parent, key };
}

function add(root: any, pointer: string, value: unknown) {
  const { parent, key } = locate(root, pointer);
  if (Array.isArray(parent)) parent.splice(index(key, parent.length, true), 0, structuredClone(value));
  else parent[key] = structuredClone(value);
}

function remove(root: any, pointer: string) {
  const { parent, key } = locate(root, pointer);
  if (Array.isArray(parent)) return parent.splice(index(key, parent.length), 1)[0];
  if (!Object.hasOwn(parent, key)) throw new Error('Patch target does not exist');
  const value = parent[key];
  delete parent[key];
  return value;
}

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual((a as any)[k], (b as any)[k]));
};

function applyPatch(root: any, op: Patch) {
  const path = resolvePointer(root, op.path);
  const from = op.from === undefined ? undefined : resolvePointer(root, op.from);
  if ((op.op === 'add' || op.op === 'replace' || op.op === 'test') && !Object.hasOwn(op, 'value')) {
    throw new Error(`${op.op} requires value`);
  }
  if ((op.op === 'move' || op.op === 'copy') && from === undefined) throw new Error(`${op.op} requires from`);
  switch (op.op) {
    case 'add':
      return add(root, path, op.value);
    case 'remove':
      return void remove(root, path);
    case 'replace': {
      const { parent, key } = locate(root, path);
      if (Array.isArray(parent)) parent[index(key, parent.length)] = structuredClone(op.value);
      else if (!Object.hasOwn(parent, key)) throw new Error('Patch target does not exist');
      else parent[key] = structuredClone(op.value);
      return;
    }
    case 'move':
      if (path === from || path.startsWith(from + '/')) throw new Error('Cannot move a value into itself');
      return add(root, path, remove(root, from!));
    case 'copy': {
      // A copied element keeps its ID; drop IDs in the copy so fresh unique ones are assigned.
      const copy = structuredClone(pointerValue(root, from!));
      const strip = (v: any) => {
        if (!v || typeof v !== 'object') return;
        if (typeof v.type === 'string') delete v.id;
        Object.values(v).forEach(strip);
      };
      strip(copy);
      return add(root, path, copy);
    }
    case 'test':
      if (!deepEqual(pointerValue(root, path), op.value)) throw new Error('Test failed: value differs');
      return;
    default:
      throw new Error(`Unsupported operation ${(op as Patch).op}`);
  }
}
