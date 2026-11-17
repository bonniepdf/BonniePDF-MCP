import { DOTNET_API } from './dotnet-api.js';
import { KnowledgeBase } from './knowledge.js';
import { validate } from './documents.js';
import { toLength } from '@bonniepdf/core';

type Obj = Record<string, any>;
export type SourceLanguage = 'typescript' | 'dotnet';
const slots = new Set(['element', 'elements', 'stackChildren', 'listItems', 'spans', 'rows', 'cells', 'cellContent']);
const pascal = (s: string) => s[0].toUpperCase() + s.slice(1);
const normal = (s: string) => s.replace(/[^a-z0-9]/gi, '').toLowerCase();
const quote = (s: string) => JSON.stringify(s).replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');

/**
 * Replaces each bundled asset reference in `definition.resources` with its base64 data, in place.
 * Exports carry their resources inline; the model never sees the payload. A reference outside the
 * bundle throws, because its bytes depend on the host.
 */
export function embedBundleResources(definition: Obj, knowledge: KnowledgeBase): Obj {
  for (const resource of Object.values(definition.resources ?? {}) as Obj[]) {
    if (!resource.ref) continue;
    if (!/^assets\/[a-f0-9]{64}$/.test(resource.ref))
      throw new Error('Export currently embeds bundle resources only; custom references remain host-dependent');
    resource.data = knowledge.file(resource.ref).toString('base64');
    delete resource.ref;
  }
  return definition;
}

/** A deterministic native-code writer. It never executes submitted source. */
export class SourceExporter {
  private readonly d: any;
  private lines: string[] = [];
  private counter = 0;
  private get cs() {
    return this.language === 'dotnet';
  }
  constructor(
    private knowledge: KnowledgeBase,
    private language: SourceLanguage
  ) {
    this.d = knowledge.elements;
  }
  private fail(path: string, message: string): never {
    throw Object.assign(new Error(`Native ${this.language} export: ${message} (${path || '/'})`), {
      issues: [{ path, code: 'native-export-unsupported', message }],
    });
  }
  private variable(name: string, expression: string) {
    const id = `${name}${++this.counter}`;
    this.lines.push(`${this.cs ? 'var' : 'const'} ${id} = ${expression};`);
    return id;
  }
  private keys(name: string) {
    const shape = this.d.elements[name] ?? this.d.shapes[name] ?? this.d.objects[name];
    if (!shape) this.fail('', `Unknown shape ${name}`);
    return Object.assign({}, ...(shape.uses ?? []).map((n: string) => this.d.mixins[n]), shape.keys);
  }
  private member(type: string, token: string, path: string) {
    const name = DOTNET_API[type]?.enums?.find(n => normal(n) === normal(token));
    if (!name) this.fail(path, `No ${type} member for ${token}`);
    return `${type}.${name}`;
  }
  private color(value: string) {
    if (!this.cs) return `B.Color.fromHex(${quote(this.hex(value))})`;
    return `Color.FromHex(${quote(this.hex(value))})`;
  }
  private hex(value: string) {
    return value;
  }
  private points(value: any): string {
    return this.number(this.pointValue(value), 'Single');
  }
  private pointValue(value: any): number {
    return toLength((typeof value === 'object' ? `${value.value}${value.unit}` : value) as never);
  }
  private number(n: number, target?: string) {
    if (!Number.isFinite(n)) this.fail('', 'Non-finite number');
    return `${n}${this.cs ? (target?.replace('?', '') === 'Decimal' ? 'm' : target?.replace('?', '') === 'Double' ? 'd' : Number.isInteger(n) ? '' : 'f') : ''}`;
  }
  private value(kind: string, v: any, path: string, target?: string): string {
    const [head, ...rest] = kind.split(':');
    const arg = rest.join(':');
    target = target?.replace(/\?$/, '');
    switch (head) {
      case 'string':
      case 'chartNumberFormat':
        return quote(v);
      case 'boolean':
        return String(v);
      case 'integer':
      case 'number':
        return this.number(v, target);
      case 'integerOrUnlimited':
        return v === 'unlimited' ? 'null' : this.number(v, target);
      case 'length':
        return this.points(v);
      case 'pageSize':
        return typeof v === 'string'
          ? this.cs
            ? `PdfSize.${pascal(v)}`
            : quote(v)
          : this.cs
            ? `new PdfSize(${this.number(v.width, 'Single')}, ${this.number(v.height, 'Single')}${v.name ? ', ' + quote(v.name) : ''})`
            : `{ width: ${v.width}, height: ${v.height}${v.name ? ', name: ' + quote(v.name) : ''} }`;
      case 'color': {
        if (!this.cs || target === 'String') return quote(v);
        if (v.startsWith('#')) return this.color(v);
        const dash = v.lastIndexOf('-');
        return `ColorPalette.${pascal(v.slice(0, dash))}[${v.slice(dash + 1)}]`;
      }
      case 'spacing':
      case 'border': {
        if (!this.cs) {
          if (typeof v !== 'object') return this.points(v);
          if (Array.isArray(v)) return `[${v.map(x => this.points(x)).join(', ')}]`;
          return `{ ${Object.entries(v)
            .map(([k, x]) => `${k}: ${k === 'color' ? quote(x as string) : this.points(x)}`)
            .join(', ')} }`;
        }
        const type = head === 'border' ? 'Border' : 'Thickness';
        if (typeof v !== 'object') return `new ${type}(${this.points(v)})`;
        if (Array.isArray(v)) return `new ${type}(${v.map(x => this.points(x)).join(', ')})`;
        if (head === 'border' && v.width !== undefined) return `new Border(${this.points(v.width)})`;
        return `new ${type}(${['left', 'top', 'right', 'bottom'].map(k => this.points(v[k] ?? 0)).join(', ')})`;
      }
      case 'enum': {
        const spec = this.d.enums[arg];
        if (!this.cs) {
          if (spec.via === 'options') return quote(v);
          // SvgShapeRendering is a string union rather than an exported enum.
          return spec.type === 'SvgShapeRendering' ? quote(spec.members[v]) : `B.${spec.type}.${spec.members[v]}`;
        }
        if (target === 'String') return quote(spec.members?.[v] ?? v);
        const type = target ?? spec.dotnet?.type ?? spec.type ?? arg;
        return this.member(type, spec.dotnet?.members?.[v] ?? v, path);
      }
      case 'fontWeight':
        return this.cs
          ? typeof v === 'number'
            ? `(FontWeight)${v}`
            : this.member('FontWeight', v, path)
          : JSON.stringify(v);
      case 'decoration':
      case 'permissions': {
        if (!this.cs && head === 'decoration') return JSON.stringify(v);
        const type = head === 'decoration' ? 'TextDecoration' : 'PdfPermissions';
        return (Array.isArray(v) ? v : [v])
          .map(token =>
            this.cs
              ? this.member(type, token, path)
              : `B.PdfPermissions.${this.d.enums.PdfPermission.members?.[token] ?? pascal(token)}`
          )
          .join(' | ');
      }
      case 'dateTime':
        return this.cs ? `DateTimeOffset.Parse(${quote(v)}, CultureInfo.InvariantCulture)` : `new Date(${quote(v)})`;
      case 'array': {
        const item = target?.endsWith('[]') ? target.slice(0, -2) : target?.slice(target.indexOf('<') + 1, -1);
        return `[${v.map((x: any, i: number) => this.value(arg, x, `${path}/${i}`, item)).join(', ')}]`;
      }
      case 'map':
      case 'fontFeatures': {
        const item = head === 'fontFeatures' ? 'Int32' : target?.slice(target.indexOf(',') + 1, -1);
        const entries = Object.entries(v).map(([k, x]) =>
          this.cs
            ? `[${quote(k)}] = ${this.value(head === 'fontFeatures' ? 'integer' : arg, x, `${path}/${k}`, item)}`
            : `${quote(k)}: ${this.value(head === 'fontFeatures' ? 'integer' : arg, x, `${path}/${k}`)}`
        );
        return this.cs
          ? `new ${(target ?? 'Dictionary<String,Int32>').replace(/^IDictionary</, 'Dictionary<')} { ${entries.join(', ')} }`
          : `{ ${entries.join(', ')} }`;
      }
      case 'object': {
        if (arg === 'BorderColors') {
          return `new ${this.cs ? '' : 'B.'}BorderColors(${['left', 'top', 'right', 'bottom'].map(k => (v[k] === undefined ? (this.cs ? 'null' : 'undefined') : this.cs ? this.value('color', v[k], path, 'Color') : `B.toColor(${quote(v[k])})`)).join(', ')})`;
        }
        return this.object(v, arg, target ?? arg, path);
      }
      default:
        return this.fail(path, `Unsupported value kind ${kind}`);
    }
  }
  private properties(node: Obj, shape: string, type: string, path: string, skip = new Set<string>()) {
    const keys = this.keys(shape);
    const props: string[] = [];
    for (const [key, spec] of Object.entries(keys) as [string, any][]) {
      if (
        !(key in node) ||
        key === 'type' ||
        key === 'id' ||
        key.startsWith('_') ||
        skip.has(key) ||
        slots.has(spec.kind.split(':')[0])
      )
        continue;
      const name = this.cs ? (key === 'pdfVersion' ? 'Version' : pascal(key)) : key === 'pdfVersion' ? 'version' : key;
      const prop = this.cs ? DOTNET_API[type]?.properties[name] : undefined;
      if (this.cs && !prop) this.fail(`${path}/${key}`, `No native ${type}.${name} mapping`);
      if (this.cs && !prop!.writable) this.fail(`${path}/${key}`, `${type}.${name} is not settable`);
      props.push(`${name}${this.cs ? ' = ' : ': '}${this.value(spec.kind, node[key], `${path}/${key}`, prop?.type)}`);
    }
    // A border's inline colour is applied separately by the definition reader.
    if (this.cs && node.border?.color && node.borderColors === undefined && DOTNET_API[type]?.properties.BorderColors) {
      props.push(
        `BorderColors = new BorderColors(${this.value('color', node.border.color, path + '/border/color', 'Color')})`
      );
    }
    return props;
  }
  private object(node: Obj, shape: string, type: string, path: string, extra: string[] = [], skip = new Set<string>()) {
    const props = [...this.properties(node, shape, type, path, skip), ...extra];
    return this.cs ? `new ${type} { ${props.join(', ')} }` : `{ ${props.join(', ')} }`;
  }
  private element(node: Obj, path: string): string {
    const type = node.type;
    const skip = new Set<string>();
    if (type === 'Image' || type === 'Svg') {
      skip.add('resource');
      skip.add('svgData');
    }
    if (type === 'Table' || type === 'Grid') skip.add('columns');
    if (!this.cs && type === 'RichText') skip.add('defaultStyle');
    if (this.cs) {
      if (type === 'SemanticGroup') skip.add('role');
      for (const key of (
        {
          PageNumberOf: ['anchorTarget'],
          Hyperlink: ['text'],
          SectionLink: ['text', 'anchorTarget'],
          Section: ['anchorId'],
        } as Record<string, string[]>
      )[type] ?? [])
        skip.add(key);
    }
    const p = this.properties(node, type, type, path, skip);
    const child = node.child === undefined ? undefined : this.element(node.child, path + '/child');
    if (child) p.push(`${this.cs ? 'Child = ' : 'child: '}${child}`);
    const ctor = (args = '', props = p) =>
      this.cs ? `new ${type}(${args}) { ${props.join(', ')} }` : `new B.${type}({ ${props.join(', ')} })`;
    if (
      [
        'VerticalStack',
        'HorizontalStack',
        'SemanticGroup',
        'Layers',
        'RichText',
        'UnorderedList',
        'OrderedList',
        'Table',
        'Grid',
      ].includes(type)
    ) {
      let expression;
      if (type === 'SemanticGroup') {
        const roleIndex = p.findIndex(x => x.startsWith('role: '));
        const role = this.cs
          ? this.member('SemanticRole', node.role, path + '/role')
          : p.splice(roleIndex, 1)[0]?.split(': ').slice(1).join(': ');
        expression = this.cs ? ctor(role) : ctor('', [...p, `role: ${role}`]);
      } else if (type === 'Layers') {
        const primary = this.element(node.primary, path + '/primary');
        expression = ctor('', [...p, `${this.cs ? 'PrimaryLayer = ' : 'primaryLayer: '}${primary}`]);
      } else if (type === 'Table' || type === 'Grid') {
        expression = this.cs
          ? ctor((node.columns ?? []).map((n: number) => this.number(n, 'Single')).join(', '))
          : ctor('', [...p, `columns: ${JSON.stringify(node.columns ?? [])}`]);
      } else if (!this.cs && (type === 'UnorderedList' || type === 'OrderedList')) {
        expression = ctor('', [...p, `items: ${JSON.stringify(node.items.filter((i: any) => typeof i === 'string'))}`]);
      } else expression = ctor();
      const variable = this.variable(type[0].toLowerCase() + type.slice(1), expression);
      if (!this.cs && type === 'RichText' && node.defaultStyle)
        this.lines.push(
          `${variable}.defaultStyle = new B.TextStyle(${this.object(node.defaultStyle, 'TextStyle', 'TextStyle', path + '/defaultStyle')});`
        );
      const method = (cs: string, ts: string, ...args: string[]) =>
        this.lines.push(`${variable}.${this.cs ? cs : ts}(${args.join(', ')});`);
      for (const [i, c] of (node.children ?? []).entries()) {
        const weighted = c.element !== undefined && c.type === undefined;
        method(
          'Add',
          'add',
          this.element(weighted ? c.element : c, `${path}/children/${i}${weighted ? '/element' : ''}`),
          ...(weighted ? [this.number(c.weight, 'Single')] : [])
        );
      }
      for (const [key, cs, ts] of [
        ['backgrounds', 'AddBackground', 'addBackground'],
        ['foregrounds', 'AddForeground', 'addForeground'],
      ])
        for (const [i, c] of (node[key] ?? []).entries()) method(cs, ts, this.element(c, `${path}/${key}/${i}`));
      for (const [i, span] of (node.spans ?? []).entries()) {
        if (span.lineBreak) method('LineBreak', 'lineBreak');
        else
          method(
            'Span',
            'span',
            quote(span.text),
            ...(span.style
              ? [
                  this.cs
                    ? this.object(span.style, 'TextStyle', 'TextStyle', `${path}/spans/${i}/style`)
                    : `new B.TextStyle(${this.object(span.style, 'TextStyle', 'TextStyle', `${path}/spans/${i}/style`)})`,
                ]
              : [])
          );
      }
      for (const [i, item] of (node.items ?? []).entries()) {
        if (typeof item === 'string') {
          if (this.cs) method('AddItem', 'addItem', quote(item));
        } else method('AddNestedList', 'addNestedList', this.element(item, `${path}/items/${i}`));
      }
      for (const [key, cs, ts] of [
        ['header', 'AddHeader', 'addHeader'],
        ['rows', 'AddRow', 'addRow'],
        ['footer', 'AddFooter', 'addFooter'],
      ])
        for (const [i, row] of (node[key] ?? []).entries()) method(cs, ts, this.row(row, `${path}/${key}/${i}`));
      return variable;
    }
    if (type === 'Image') p.push(`${this.cs ? 'ImageData = ' : 'imageData: '}${this.resource(node.resource, path)}`);
    if (type === 'Svg')
      p.push(
        `${this.cs ? 'SvgData = ' : 'svgData: '}${node.svgData !== undefined ? quote(node.svgData) : this.cs ? `Encoding.UTF8.GetString(${this.resource(node.resource, path)})` : `new TextDecoder().decode(${this.resource(node.resource, path)})`}`
      );
    const required: Record<string, string[]> = {
      TextBlock: ['text'],
      Heading: ['text', 'tocIdentifier'],
      PageNumberOf: ['anchorTarget'],
      Hyperlink: ['text'],
      SectionLink: ['text', 'anchorTarget'],
      Section: ['anchorId'],
    };
    if (this.cs) {
      const args: string[] = [];
      if (['PageNumberOf', 'Hyperlink', 'SectionLink', 'Section'].includes(type)) {
        for (const key of required[type]) {
          args.push(quote(node[key]));
          const index = p.findIndex(x => x.startsWith(`${pascal(key)} = `));
          if (index >= 0) p.splice(index, 1);
        }
      } else for (const key of required[type] ?? []) if (node[key] === undefined) p.push(`${pascal(key)} = ""`);
      return ctor(args.join(', '));
    }
    return ctor();
  }
  private row(row: any, path: string) {
    const cells = (Array.isArray(row) ? row : row.cells).map((cell: any, i: number) =>
      this.cell(cell, `${path}/cells/${i}`)
    );
    if (this.cs)
      return this.object(Array.isArray(row) ? {} : row, 'TableRow', 'TableRow', path, [
        `Cells = [${cells.join(', ')}]`,
      ]);
    return `new B.TableRow(${this.object(Array.isArray(row) ? {} : row, 'TableRow', 'TableRow', path, [`cells: [${cells.join(', ')}]`])})`;
  }
  private cell(cell: any, path: string): string {
    const explicit = cell?.type === 'TableCell';
    const value = explicit ? cell.content : cell;
    const content =
      typeof value === 'string'
        ? this.element({ type: 'TextBlock', text: value }, path + '/content')
        : this.element(value, path + '/content');
    const bag = this.object(explicit ? cell : {}, 'TableCell', 'TableCell', path, [
      `${this.cs ? 'Content = ' : 'content: '}${content}`,
    ]);
    return this.cs ? bag : `new B.TableCell(${bag})`;
  }
  private resources: Record<string, string> = {};
  private resource(name: string, path: string) {
    return this.resources[name] ?? this.fail(path, `Missing resource ${name}`);
  }
  export(input: Obj): string {
    this.lines = [];
    this.counter = 0;
    this.resources = {};
    const checked = validate(input);
    if (!checked.valid)
      throw Object.assign(new Error('Cannot export an invalid definition'), { issues: checked.errors });
    const fontWalk = (v: any, path: string) => {
      if (!v || typeof v !== 'object') return;
      for (const [k, x] of Object.entries(v)) {
        if ((k === 'fontName' || k === 'fontFamily') && typeof x === 'string' && x.startsWith('/fonts/'))
          this.fail(
            path + '/' + k,
            'Catalogue font paths need an explicit native font alias. Use JSON export or embed a font resource and select its family'
          );
        fontWalk(x, path + '/' + k);
      }
    };
    fontWalk(input, '');
    if (input.settings?.encryption)
      this.fail(
        '/settings/encryption',
        'Supply encryption credentials in your application; secrets are not present in definitions'
      );
    for (const [name, r] of Object.entries(input.resources ?? {}) as [string, any][]) {
      if (!r.data) this.fail('/resources/' + name, 'Native exports require embedded resource data');
      this.resources[name] = this.variable(
        'resource',
        this.cs
          ? `Convert.FromBase64String(${quote(r.data)})`
          : `Uint8Array.from(atob(${quote(r.data)}), c => c.charCodeAt(0))`
      );
    }
    const settings = input.settings ?? {};
    const settingsVar = this.variable(
      'documentSettings',
      this.cs
        ? this.object(settings, 'Settings', 'DocumentSettings', '/settings', [], new Set(['pageChrome']))
        : `new B.DocumentSettings(${this.object(settings, 'Settings', 'DocumentSettings', '/settings', [], new Set(['pageChrome', 'namedDestinations']))})`
    );
    const first = input.pages[0];
    if (first.margin !== undefined)
      this.fail(
        '/pages/0/margin',
        'An explicit first-page margin cannot be preserved through the current native public API. Use JSON export, or put the margin in document settings'
      );
    for (const [key, field] of [
      ['size', 'pageSize'],
      ['orientation', 'orientation'],
      ['margin', 'margin'],
    ])
      if (first[key] !== undefined) {
        const name = this.cs ? pascal(field) : field;
        this.lines.push(
          `${settingsVar}.${name} = ${this.value(key === 'size' ? 'pageSize' : key === 'margin' ? 'length' : 'enum:PageOrientation', first[key], '/pages/0/' + key, this.cs ? DOTNET_API.DocumentSettings.properties[name].type : undefined)};`
        );
      }
    const metadata = this.cs
      ? this.object(input.metadata ?? {}, 'Metadata', 'DocumentMetadata', '/metadata')
      : this.object(input.metadata ?? {}, 'Metadata', 'DocumentMetadata', '/metadata');
    this.lines.push(
      this.cs
        ? `using var document = new Document(${settingsVar}, ${metadata});`
        : `const document = new B.Document({ settings: ${settingsVar}, metadata: ${metadata} });`
    );
    // Restore document defaults after constructing the first page, as the definition reader does.
    for (const [key, field] of [
      ['size', 'pageSize'],
      ['orientation', 'orientation'],
      ['margin', 'margin'],
    ])
      if (first[key] !== undefined) {
        const defaultValue =
          settings[field] ?? (field === 'pageSize' ? 'a4' : field === 'orientation' ? 'portrait' : 50);
        const name = this.cs ? pascal(field) : field;
        this.lines.push(
          `document.${this.cs ? 'Settings' : 'settings'}.${name} = ${this.value(key === 'size' ? 'pageSize' : key === 'margin' ? 'length' : 'enum:PageOrientation', defaultValue, '/settings/' + field, this.cs ? DOTNET_API.DocumentSettings.properties[name].type : undefined)};`
        );
      }
    if (!this.cs && settings.namedDestinations)
      this.lines.push(
        `document.settings.namedDestinations = new Map(${JSON.stringify(Object.entries(settings.namedDestinations))});`
      );
    for (const [slot, field] of [
      ['header', 'headerTemplate'],
      ['footer', 'footerTemplate'],
      ['background', 'pageBackground'],
      ['foreground', 'pageForeground'],
    ])
      if (settings.pageChrome?.[slot]) {
        const entries = Object.entries(settings.pageChrome[slot]).map(
          ([k, v]) =>
            `${this.cs ? (k === 'default' ? '@default' : k) : k}${this.cs ? ': ' : ': '}${this.element(v as Obj, `/settings/pageChrome/${slot}/${k}`)}`
        );
        this.lines.push(
          `document.${this.cs ? 'Settings' : 'settings'}.${this.cs ? pascal(field) : field} = ${this.cs ? 'PageTemplate.FromElements(' + entries.join(', ') + ')' : 'B.pageTemplate({ ' + entries.join(', ') + ' })'};`
        );
      }
    for (const [name, r] of Object.entries(input.resources ?? {}) as [string, any][])
      if (r.kind === 'font') {
        const bytes = this.resource(name, '/resources/' + name);
        this.lines.push(
          this.cs
            ? `document.Fonts.Add(${bytes}, ${r.family ? quote(r.family) : 'null'}, ${r.weight !== undefined ? this.value('fontWeight', r.weight, '/resources/' + name + '/weight') : 'null'}, ${r.italic === undefined ? 'null' : r.italic});`
            : `document.fonts.add(${bytes}, ${JSON.stringify({ family: r.family, weight: r.weight, italic: r.italic })});`
        );
      }
    for (const [i, page] of input.pages.entries()) {
      const path = `/pages/${i}`;
      let variable = `document.${this.cs ? 'Pages' : 'pages'}[0]`;
      if (i) {
        const size = page.size ?? settings.pageSize ?? 'a4';
        const orientation = page.orientation ?? settings.orientation ?? 'portrait';
        variable = this.variable(
          'page',
          this.cs
            ? `document.AddPage(${this.value('pageSize', size, path + '/size')}, ${this.member('PageOrientation', orientation, path + '/orientation')}${page.margin === undefined ? '' : ', ' + this.points(page.margin)})`
            : `document.addPage({ size: ${typeof size === 'string' ? 'B.PdfSize.' + size : 'new B.PdfSize(' + size.width + ', ' + size.height + (size.name ? ', ' + quote(size.name) : '') + ')'}, orientation: B.PageOrientation.${pascal(orientation)}${page.margin === undefined ? '' : ', margin: ' + this.points(page.margin)} })`
        );
      }
      if (page.pageColor)
        this.lines.push(
          `${variable}.${this.cs ? 'PageColor' : 'pageColor'} = ${this.value('color', page.pageColor, path + '/pageColor', 'Color')};`
        );
      for (const slot of ['background', 'foreground'])
        if (page[slot])
          this.lines.push(
            `${variable}.${this.cs ? pascal('page' + pascal(slot)) : 'page' + pascal(slot)} = ${this.element(page[slot], path + '/' + slot)};`
          );
      for (const [j, node] of page.content.entries()) {
        const element = this.element(node, `${path}/content/${j}`);
        this.lines.push(`${variable}.${this.cs ? 'Add' : 'add'}(${element});`);
      }
    }
    for (const [i, a] of (input.attachments ?? []).entries()) {
      const props = [
        `${this.cs ? 'FileName = ' : 'fileName: '}${quote(a.fileName)}`,
        `${this.cs ? 'Content = ' : 'content: '}${this.resource(a.resource, `/attachments/${i}/resource`)}`,
      ];
      for (const key of ['mediaType', 'description', 'relationship', 'creationDate', 'modificationDate'])
        if (a[key] !== undefined)
          props.push(
            `${this.cs ? pascal(key) + ' = ' : key + ': '}${this.value(key === 'relationship' ? 'enum:AttachmentRelationship' : key.endsWith('Date') ? 'dateTime' : 'string', a[key], `/attachments/${i}/${key}`)}`
          );
      this.lines.push(
        this.cs
          ? `document.Attach(new FileAttachment { ${props.join(', ')} });`
          : `document.attach({ ${props.join(', ')} });`
      );
    }
    const imports = this.cs
      ? 'using System;\nusing System.Collections.Generic;\nusing System.Globalization;\nusing System.Text;\nusing BonniePDF;'
      : "import * as B from '@bonniepdf/core';";
    const license = this.cs ? 'BonniePdfLicense.Tier = LicenseTier.Evaluation;' : "B.settings.license = 'evaluation';";
    return `// Generated from an edited BonniePDF definition. Select the licence tier appropriate to your application.\n${imports}\n\n${license}\n\n${this.lines.join('\n')}\n\n${this.cs ? 'await document.SaveAsync("document.pdf");' : 'await document.saveAsync("document.pdf");'}\n`;
  }
}
