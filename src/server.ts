import { McpServer, ResourceTemplate } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { KnowledgeBase } from './knowledge.js';
import { DocumentStore, validate } from './documents.js';
import { Renderer, type RendererOptions } from './render.js';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { SourceExporter, embedBundleResources } from './source-export.js';

export const GUIDE = `BonniePDF authors documents from a tree of elements, not HTML. Use search_docs to find a recipe or finished design. get_example returns source or JSON on demand; create_document(exampleId) clones a verified definition without sending it through the conversation. create_document(definition) accepts a new definition, and create_document(blank: true) starts an empty page. Handles last for this server connection unless the host enables persistence; list_documents shows them.
Locate elements with find_elements (by text, type or ID) rather than reading the whole tree. Every path accepts an RFC 6901 JSON Pointer or #elementId/rest, e.g. #mcp-4/text. Read only what you need with get_document; edit with patch_document (add, remove, replace, move, copy, test) and its current revision. patch_and_preview edits and renders in one call. IDs added by the host link body elements to layout sourceId. Page chrome is outside the layout snapshot tree.
Use describe_element for exact keys, nested shapes and tokens; add property to inspect accepted JSON values and constraints without reading the whole schema. Page sizes use lowercase tokens such as "a4"; numeric lengths are points. To center a fixed-size design on a page, use an outer Container with fillHeight: true, horizontalAlignment: "center", verticalAlignment: "middle", and a child Container with explicit width and height. Rotate wraps native content: use angle: 90 or -90 and mode: "constrained" for sideways labels; contentWidth fixes the unrotated width. Free rotation keeps its original flow box, so provide clearance. Rotation is atomic and cannot contain page breaks. JSON keys are case-sensitive. validate_definition uses BonniePDF's strict semantic validator, not only JSON Schema. preview_definition returns page count, advisory accessibility findings, selected SVG/PNG artifacts and optionally images. Inspect the selected preview before finalising; a valid definition does not guarantee the requested content or attractive layout. render_pdf produces an artifact, never executable code. export_definition saves portable JSON or native C#/TypeScript code for reuse. Resources resolve only from the bundle or the host's configured resource directory. Passwords are not stored in definitions; encrypted source examples are source-only.
Many source examples use callbacks unavailable in JSON. The server labels these source-only rather than dropping content. Retrieve their TypeScript/C# source when writing code examples. Use export_definition with format "json", "typescript", "dotnet" or "all" to export the current edited document. TypeScript and C# exports use native constructors and properties, embedding resource data; unsupported constructs return an explicit error. Advisory preflight does not certify PDF/A/PDF/UA compliance. Use external validation where required.
For economical authoring, search editable examples first. create_document accepts output: "preview", "pdf" or "pdf-and-preview" to create and render in one call; omit output to edit first. Supply names to describe_element to fetch up to eight element types together. Plan a complete first layout, batch related edits, then preview only the pages needed. Correct specific visible problems rather than repeatedly rebuilding the document. Do not read a whole definition or layout snapshot when find_elements and focused reads suffice. Content and tool responses still enter the connected assistant's context.`;

/** A shorter guide for small local models, matching the lite tool set. */
export const LITE_GUIDE = `You build PDFs with BonniePDF. Workflow:
1. search_docs("invoice") finds an editable example; create_document({exampleId}) opens it and returns a documentId, revision and outline. For a new document, create_document({blank: true}) and add elements to "/pages/0/content/-".
2. find_elements({documentId, text:"..."}) finds the element to change. Paths may be "#<elementId>/<key>", e.g. "#mcp-4/text".
3. patch_and_preview({documentId, revision, operations:[{op:"replace", path:"#mcp-4/text", value:"New text"}]}) applies edits, then shows the page. Always pass the latest revision.
4. describe_element("TextBlock") lists valid keys before you add a new element.
5. render_pdf({documentId}) saves the PDF when finished. If no edits are needed, create_document({exampleId, output:"pdf-and-preview"}) creates, previews and saves in one call. describe_element({names:["TextBlock","Container"]}) fetches several types together. Batch related changes and avoid repeated previews without a specific correction.
Errors explain what to fix; nothing changes when an edit fails.`;

/** The smallest valid definition: one empty page with the default size and margins. */
const BLANK = { version: 1, minorVersion: 0, metadata: { title: 'Untitled' }, pages: [{ content: [] }] };

const LITE_TOOLS = new Set([
  'search_docs',
  'describe_element',
  'create_document',
  'find_elements',
  'get_document',
  'patch_and_preview',
  'render_pdf',
]);

export interface ServerOptions extends RendererOptions {
  outDir: string;
  /** `lite` exposes a smaller tool set with shorter descriptions, for small local models. */
  profile?: 'full' | 'lite';
  /** Saves session documents here so handles survive restarts. */
  sessionDir?: string;
  /** Opt-in JSONL measurements; never includes document content or image data. */
  metricsFile?: string;
}

export function createServer(options: ServerOptions) {
  const profile = options.profile ?? 'full';
  const lite = profile === 'lite';
  const guide = lite ? LITE_GUIDE : GUIDE;
  const knowledge = new KnowledgeBase();
  const store = new DocumentStore(options.sessionDir);
  const renderer = new Renderer(options.outDir, options);
  const server = new McpServer({ name: 'bonniepdf', version: '0.2.0' }, { instructions: guide });
  const result = (value: Record<string, unknown>) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent: value,
    ...(value.valid === false ? { isError: true } : {}),
  });
  const excerpt = (text: string, offset: number, maxChars: number) => ({
    text: text.slice(offset, offset + maxChars),
    offset,
    nextOffset: offset + maxChars < text.length ? offset + maxChars : null,
    totalChars: text.length,
  });
  const tool = (
    name: string,
    description: string | { full: string; lite: string },
    inputSchema: z.ZodObject<any>,
    readOnlyHint: boolean,
    handler: (args: any, ctx: any) => Promise<any> | any
  ) => {
    if (lite && !LITE_TOOLS.has(name)) return;
    const text = typeof description === 'string' ? description : description[profile];
    server.registerTool(
      name,
      { description: text, inputSchema, annotations: { readOnlyHint, destructiveHint: false, openWorldHint: false } },
      async (args, ctx) => {
        const started = performance.now();
        let response;
        try {
          response = await handler(args, ctx);
        } catch (error) {
          const e = error as Error & { issues?: unknown[] };
          response = {
            ...result({ error: { message: e.message, ...(e.issues ? { issues: e.issues.slice(0, 25) } : {}) } }),
            isError: true,
          };
        }
        if (options.metricsFile) {
          const content = response.content ?? [];
          const measurement = {
            timestamp: new Date().toISOString(),
            tool: name,
            profile,
            durationMs: Math.round(performance.now() - started),
            inputBytes: Buffer.byteLength(JSON.stringify(args)),
            textBytes: content
              .filter((c: any) => c.type === 'text')
              .reduce((n: number, c: any) => n + Buffer.byteLength(c.text), 0),
            structuredBytes: Buffer.byteLength(JSON.stringify(response.structuredContent ?? {})),
            imageBytes: content
              .filter((c: any) => c.type === 'image')
              .reduce((n: number, c: any) => n + Buffer.from(c.data, 'base64').length, 0),
            isError: !!response.isError,
          };
          try {
            await mkdir(dirname(options.metricsFile), { recursive: true });
            await appendFile(options.metricsFile, JSON.stringify(measurement) + '\n');
          } catch {
            console.error('Could not write MCP measurements');
          }
        }
        return response;
      }
    );
  };
  const id = z.string().uuid();
  const offset = z.number().int().min(0).default(0);
  const maxChars = z.number().int().min(256).max(16000).default(6000);
  const pointer = z.string().max(1000);
  const operations = z
    .array(
      z.object({
        op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
        path: pointer,
        value: z.unknown().optional(),
        from: pointer.optional(),
      })
    )
    .min(1)
    .max(50);
  const pages = z.array(z.number().int().min(0).max(99)).min(1).max(3).default([0]);
  const scale = z.number().min(0.5).max(2).default(1);

  const preview = async (
    documentId: string,
    selected: number[],
    includeImages: boolean,
    zoom: number,
    signal?: AbortSignal
  ) => {
    const doc = store.get(documentId);
    const revision = doc.revision;
    const rendered = await renderer.render(
      structuredClone(doc.definition),
      'preview',
      [...new Set(selected)],
      includeImages,
      signal,
      { scale: zoom }
    );
    const images = rendered
      .previews!.filter(p => p.image)
      .map(p => ({ type: 'image' as const, data: p.image!, mimeType: 'image/png' }));
    const value = { ...rendered, documentId, revision, previews: rendered.previews!.map(({ image, ...p }) => p) };
    const base = result(value);
    return { ...base, content: [...base.content, ...images] };
  };

  const pdf = async (documentId: string, preflight: boolean, signal?: AbortSignal) => {
    const doc = store.get(documentId);
    const revision = doc.revision;
    const rendered = await renderer.render(structuredClone(doc.definition), 'pdf', [0], false, signal, { preflight });
    const response = result({ ...rendered, documentId, revision });
    return {
      ...response,
      content: [
        ...response.content,
        {
          type: 'resource_link' as const,
          uri: rendered.artifact!.uri,
          name: 'document.pdf',
          mimeType: 'application/pdf',
          description: rendered.artifact!.path,
        },
      ],
    };
  };

  tool('get_capabilities', 'Get versions, available elements, catalogue counts and limits.', z.object({}), true, () =>
    result({
      coreVersion: knowledge.data.coreVersion,
      definitionVersion: knowledge.data.definitionVersion,
      knowledgeHash: knowledge.data.hash,
      exampleClock: knowledge.data.exampleClock,
      profile,
      examples: knowledge.data.examples.length,
      editableExamples: knowledge.data.examples.filter(e => e.definition).length,
      referencePages: knowledge.data.docs.length,
      elements: Object.keys(knowledge.elements.elements),
      persistentSessions: !!options.sessionDir,
      guide: 'bonniepdf://guide',
    })
  );
  tool(
    'search_docs',
    {
      full: 'Search short example and public API summaries. Use editableOnly when seeking a JSON starting point.',
      lite: 'Find editable example documents to start from, e.g. "invoice" or "shipping label".',
    },
    z.object({
      query: z.string().max(300),
      kind: z.enum(['all', 'examples', 'docs']).default(lite ? 'examples' : 'all'),
      limit: z.number().int().min(1).max(15).default(5),
      language: z.enum(['typescript', 'dotnet']).optional(),
      editableOnly: z.boolean().default(lite),
    }),
    true,
    args => result(knowledge.search(args.query, args.kind, args.limit, args.language, args.editableOnly))
  );
  tool(
    'get_doc',
    'Read a reference page in bounded sections using its search result ID.',
    z.object({ id: z.string().max(200), offset, maxChars }),
    true,
    args => {
      const doc = knowledge.data.docs.find(d => d.id === args.id);
      if (!doc) throw new Error('Unknown reference page');
      return result({ id: doc.id, title: doc.title, url: doc.url, ...excerpt(doc.text, args.offset, args.maxChars) });
    }
  );
  tool(
    'describe_element',
    {
      full: 'Get definition keys and tokens for an element, object or value type (e.g. Page, Length). Add property (e.g. Page + size, HorizontalStack + children) for its exact JSON schema and constraints. Supply names to fetch up to eight types in one call. Omit name to list types.',
      lite: 'List valid keys and tokens, e.g. TextBlock or Page. Add property for exact accepted JSON values, e.g. name: "Page", property: "size". Supply names to fetch up to eight types in one call. Omit name to list types.',
    },
    z.object({
      name: z.string().max(100).default(''),
      property: z.string().min(1).max(100).optional(),
      names: z.array(z.string().min(1).max(100)).min(1).max(8).optional(),
    }),
    true,
    args => {
      if (args.names) {
        if (args.name || args.property) throw new Error('Supply names alone, or name with optional property');
        return result({ elements: [...new Set<string>(args.names)].map(name => knowledge.describe(name)) });
      }
      return result(knowledge.describe(args.name, args.property));
    }
  );
  tool(
    'get_example',
    'Read example metadata or a bounded section of its definition, TypeScript or C# source. Prefer create_document(exampleId) to avoid copying JSON.',
    z.object({
      exampleId: z.string().max(100),
      view: z.enum(['summary', 'definition', 'typescript', 'dotnet']).default('summary'),
      offset,
      maxChars,
    }),
    true,
    args => {
      const entry = knowledge.example(args.exampleId);
      if (args.view === 'summary') return result({ ...entry });
      const file = args.view === 'definition' ? entry.definition : entry.source[args.view as 'typescript' | 'dotnet'];
      if (!file) throw new Error(entry.unavailable ?? `No ${args.view} representation for this example`);
      return result({
        exampleId: entry.id,
        view: args.view,
        ...excerpt(knowledge.file(file).toString('utf8'), args.offset, args.maxChars),
      });
    }
  );
  tool(
    'create_document',
    {
      full: 'Create an editable session from a verified exampleId, a complete JSON definition, or blank: true for an empty A4 page. Returns a handle, revision and short outline (8 elements by default). Set output to preview, pdf or pdf-and-preview to create and render in one call; omit it when editing first.',
      lite: 'Open an editable copy of an example ({exampleId}), or start an empty page ({blank: true}) and add elements to /pages/0/content/-. Returns documentId, revision and an outline. output: "preview", "pdf" or "pdf-and-preview" renders immediately in the same call.',
    },
    z.object({
      exampleId: z.string().max(100).optional(),
      definition: z.record(z.string(), z.unknown()).optional(),
      blank: z.boolean().optional(),
      output: z.enum(['outline', 'preview', 'pdf', 'pdf-and-preview']).default('outline'),
      outlineLimit: z.number().int().min(0).max(25).default(8),
      pages,
      includeImages: z.boolean().default(true),
      scale,
    }),
    false,
    async (args, ctx) => {
      if (Number(!!args.exampleId) + Number(!!args.definition) + Number(!!args.blank) !== 1)
        throw new Error('Supply exactly one of exampleId, definition or blank: true');
      let definition = args.blank ? BLANK : args.definition;
      if (args.exampleId) {
        const entry = knowledge.example(args.exampleId);
        if (!entry.definition)
          throw new Error(`Source-only example: ${entry.unavailable}. Use get_example to retrieve its source.`);
        definition = JSON.parse(knowledge.file(entry.definition).toString('utf8'));
      }
      const created = store.create(definition);
      if (!created.valid) return result(created);
      if (args.output === 'outline') {
        const outline = created.outline.slice(0, args.outlineLimit);
        return result({
          ...created,
          outline,
          outlineTruncated: created.elements > outline.length,
          ...(created.elements > outline.length
            ? { hint: 'Use find_elements to locate other elements by text, type or ID.' }
            : {}),
        });
      }
      // Keep the handle in errors: creation has succeeded even if rendering fails.
      try {
        if (args.output === 'preview')
          return await preview(created.documentId, args.pages, args.includeImages, args.scale, ctx.signal);
        const rendered = await pdf(created.documentId, false, ctx.signal);
        if (args.output === 'pdf') return rendered;
        const shown = await preview(created.documentId, args.pages, args.includeImages, args.scale, ctx.signal);
        return {
          ...result({ ...rendered.structuredContent, preview: shown.structuredContent }),
          content: [
            ...rendered.content.filter(c => c.type !== 'text'),
            ...shown.content.filter(c => c.type !== 'text'),
            {
              type: 'text' as const,
              text: JSON.stringify({ ...rendered.structuredContent, preview: shown.structuredContent }),
            },
          ],
        };
      } catch (error) {
        return {
          ...result({
            documentId: created.documentId,
            revision: created.revision,
            error: { message: (error as Error).message },
            hint: 'Creation succeeded. Inspect or patch this handle before rendering again.',
          }),
          isError: true,
        };
      }
    }
  );
  tool('list_documents', 'List open document handles with their revision and title.', z.object({}), true, () =>
    result({ documents: store.list() })
  );
  tool(
    'get_document',
    {
      full: 'Read a definition subtree by JSON Pointer or #elementId, with bounded text and its current revision.',
      lite: 'Read part of a document by path, e.g. "#mcp-4" or "/metadata". Returns the current revision.',
    },
    z.object({ documentId: id, pointer: pointer.default(''), offset, maxChars }),
    true,
    args => {
      const doc = store.read(args.documentId, args.pointer);
      return result({
        documentId: doc.documentId,
        revision: doc.revision,
        pointer: doc.pointer,
        ...excerpt(JSON.stringify(doc.value, null, 2), args.offset, args.maxChars),
      });
    }
  );
  tool(
    'find_elements',
    {
      full: 'Find elements by contained text, element type or ID. Returns IDs and JSON Pointers to use in get_document and patch_document.',
      lite: 'Find elements by text (case-insensitive), type or id. Returns ids and paths to edit.',
    },
    z.object({
      documentId: id,
      text: z.string().max(200).optional(),
      type: z.string().max(100).optional(),
      id: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    true,
    args => result(store.find(args.documentId, args))
  );
  tool(
    'patch_document',
    'Atomically apply JSON Patch operations (add, remove, replace, move, copy, test) using JSON Pointers or #elementId paths. Requires the current revision; invalid edits leave the document unchanged.',
    z.object({ documentId: id, revision: z.number().int().min(1), operations }),
    false,
    args => result(store.patch(args.documentId, args.revision, args.operations))
  );
  tool(
    'patch_and_preview',
    {
      full: 'Apply patch_document operations, then preview the result in the same call. Nothing is rendered when the edit is invalid.',
      lite: 'Edit a document and show the page. operations: [{op:"replace"|"add"|"remove", path, value}]. Pass the latest revision.',
    },
    z.object({
      documentId: id,
      revision: z.number().int().min(1),
      operations,
      pages,
      includeImages: z.boolean().default(true),
      scale,
    }),
    false,
    async (args, ctx) => {
      const patched = store.patch(args.documentId, args.revision, args.operations);
      if (!patched.valid) return result(patched);
      return preview(args.documentId, args.pages, args.includeImages, args.scale, ctx.signal);
    }
  );
  tool('delete_document', 'Release an unused document handle.', z.object({ documentId: id }), false, args =>
    result(store.delete(args.documentId))
  );
  tool(
    'validate_definition',
    'Strictly validate a session document or supplied JSON, returning semantic errors with paths and element IDs.',
    z.object({ documentId: id.optional(), definition: z.record(z.string(), z.unknown()).optional() }),
    true,
    args => {
      if (Number(!!args.documentId) + Number(!!args.definition) !== 1)
        throw new Error('Supply exactly one of documentId or definition');
      const v = validate(args.documentId ? store.get(args.documentId).definition : args.definition);
      return result({
        valid: v.valid,
        errors: v.errors.slice(0, 25),
        warnings: v.warnings.slice(0, 25),
        errorCount: v.errors.length,
        warningCount: v.warnings.length,
      });
    }
  );
  tool(
    'preview_definition',
    'Render selected zero-based pages: page count, advisory preflight, layout and SVG/PNG artifacts. Images cost context; disable includeImages when geometry is sufficient. scale enlarges the PNG (1 = 72 dpi).',
    z.object({ documentId: id, pages, includeImages: z.boolean().default(true), scale }),
    false,
    (args, ctx) => preview(args.documentId, args.pages, args.includeImages, args.scale, ctx.signal)
  );
  tool(
    'render_pdf',
    {
      full: 'Render a session definition to a new PDF artifact. Returns a file path/resource link, page count and diagnostics; does not send PDF bytes into context. preflight adds the advisory accessibility report at the cost of a second layout.',
      lite: 'Save the finished document as a PDF file. Returns its path.',
    },
    z.object({ documentId: id, preflight: z.boolean().default(false) }),
    false,
    (args, ctx) => pdf(args.documentId, args.preflight, ctx.signal)
  );
  tool(
    'export_definition',
    'Export the edited document as portable JSON or native TypeScript/C# document-building code. format: json (default), typescript, dotnet or all. Returns file artifacts, not source text in context. Native exports fail explicitly for unsupported constructs.',
    z.object({ documentId: id, format: z.enum(['json', 'typescript', 'dotnet', 'all']).default('json') }),
    false,
    async args => {
      const doc = store.get(args.documentId);
      // Bundled assets can be exported without exposing large base64 payloads to the model.
      const definition = embedBundleResources(structuredClone(doc.definition), knowledge);
      const v = validate(definition);
      if (!v.valid) throw Object.assign(new Error('Exported definition failed validation'), { issues: v.errors });
      if (args.format !== 'json') {
        const formats = args.format === 'all' ? ['json', 'typescript', 'dotnet'] : [args.format];
        // Prepare every requested format before saving: an unsupported native construct produces no partial export.
        const files = formats.map(format =>
          format === 'json'
            ? { format, name: 'document.json', text: JSON.stringify(definition, null, 2), mimeType: 'application/json' }
            : {
                format,
                name: format === 'dotnet' ? 'Program.cs' : 'document.ts',
                text: new SourceExporter(knowledge, format as 'dotnet' | 'typescript').export(definition),
                mimeType: 'text/plain',
              }
        );
        const artifacts = [];
        for (const file of files)
          artifacts.push({ format: file.format, ...(await renderer.save(file.name, file.text, file.mimeType)) });
        const response = result({
          documentId: args.documentId,
          revision: doc.revision,
          ...(artifacts.length === 1 ? { artifact: artifacts[0] } : { artifacts }),
          usage: {
            typescript:
              'Install @bonniepdf/core, compile as an ES module, then run with Node.js. The program writes document.pdf.',
            dotnet:
              'Create a .NET 8+ console project, add BonniePDF, replace Program.cs and run dotnet run. The program writes document.pdf.',
          },
          license: 'Generated programs declare Evaluation; select the tier appropriate to your application.',
        });
        return {
          ...response,
          content: [
            ...response.content,
            ...artifacts.map(a => ({
              type: 'resource_link' as const,
              uri: a.uri,
              name: a.path.split(/[\\/]/).at(-1)!,
              mimeType: a.mimeType,
              description: a.path,
            })),
          ],
        };
      }
      return result({
        documentId: args.documentId,
        revision: doc.revision,
        artifact: await renderer.save('document.json', JSON.stringify(definition, null, 2), 'application/json'),
      });
    }
  );
  server.registerResource(
    'authoring-guide',
    'bonniepdf://guide',
    { mimeType: 'text/plain', description: 'How to author and revise documents economically' },
    uri => ({
      contents: [{ uri: uri.href, text: guide, mimeType: 'text/plain' }],
    })
  );
  server.registerResource(
    'definition-schema',
    'bonniepdf://schema/definition/1.0',
    { mimeType: 'application/schema+json' },
    uri => ({
      contents: [
        { uri: uri.href, text: knowledge.file('schema.json').toString('utf8'), mimeType: 'application/schema+json' },
      ],
    })
  );
  server.registerResource(
    'artifact',
    new ResourceTemplate('bonniepdf://artifacts/{id}', { list: undefined }),
    { description: 'Artifacts explicitly produced during this connection' },
    async (uri, variables) => {
      const artifact = await renderer.readArtifact(String(variables.id));
      if (artifact.bytes > 8_000_000)
        throw new Error('Artifact too large for inline reading; open its returned local path');
      return { contents: [{ uri: uri.href, mimeType: artifact.mimeType, blob: artifact.data.toString('base64') }] };
    }
  );
  server.registerPrompt(
    'author-document',
    {
      description: 'A workflow for creating a BonniePDF document',
      argsSchema: z.object({ brief: z.string().max(4000) }),
    },
    ({ brief }) => ({
      messages: [
        { role: 'user', content: { type: 'text', text: `Create this BonniePDF document: ${brief}\n\n${guide}` } },
      ],
    })
  );
  return server;
}
