import { KnowledgeBase } from '../dist/knowledge.js';
import { SourceExporter } from '../dist/source-export.js';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'out/native-exports');
await mkdir(out, { recursive: true });
const k = new KnowledgeBase();
const fixtures = {
  'native-edge-cases': {
    version: 1,
    minorVersion: 0,
    settings: {
      margin: 36,
      namedDestinations: { intro: 0 },
      defaultTextStyle: { fontFamily: 'ExportFont', fontSize: 10 },
      pageChrome: { footer: { default: { type: 'TextBlock', text: '{{CurrentPage}} / {{TotalPages}}' } } },
    },
    resources: {
      face: {
        kind: 'font',
        mediaType: 'font/ttf',
        family: 'ExportFont',
        weight: 400,
        data: k.file('fonts/NotoSans-Regular.ttf').toString('base64'),
      },
    },
    pages: [
      {
        content: [
          {
            type: 'Container',
            padding: ['1pt', '2pt', '3pt', '4pt'],
            border: { width: '1pt', color: 'blue-500' },
            child: {
              type: 'TextBlock',
              text: 'Quotes " \\ new line\n${notCode} `backtick`',
              margin: { bottom: { value: 2, unit: 'mm' } },
            },
          },
          {
            type: 'RichText',
            defaultStyle: { color: '#334455', fontSize: 10 },
            spans: [
              { text: 'Native ', style: { fontWeight: 'bold', decoration: ['underline'] } },
              { lineBreak: true },
              { text: 'export' },
            ],
          },
          { type: 'Table', columns: [1, 1], rows: [['One', 'Two']] },
        ],
      },
      { size: 'a5', orientation: 'landscape', margin: '1cm', content: [{ type: 'TextBlock', text: 'Page two' }] },
    ],
  },
};
const definitionFor = id => fixtures[id] ?? JSON.parse(k.file(k.example(id).definition));
const requested = process.argv.includes('--all')
  ? [...k.data.examples.filter(e => e.definition).map(e => e.id), ...Object.keys(fixtures)]
  : process.argv.slice(2).length
    ? process.argv.slice(2)
    : ['business-invoice'];
const unsupported = [];
const ids = requested.filter(id => {
  const d = structuredClone(definitionFor(id));
  for (const r of Object.values(d.resources ?? {}))
    if (r.ref) {
      r.data = k.file(r.ref).toString('base64');
      delete r.ref;
    }
  try {
    for (const language of ['typescript', 'dotnet']) new SourceExporter(k, language).export(d);
    return true;
  } catch (error) {
    if (!process.argv.includes('--all')) throw error;
    unsupported.push({ id, message: error.message });
    return false;
  }
});
await writeFile(resolve(out, 'unsupported.json'), JSON.stringify(unsupported, null, 2));
console.log('Supported:', ids.length, 'Explicitly unsupported:', unsupported.length);
const methods = [];
for (const [i, id] of ids.entries()) {
  const d = structuredClone(definitionFor(id));
  for (const r of Object.values(d.resources ?? {}))
    if (r.ref) {
      r.data = k.file(r.ref).toString('base64');
      delete r.ref;
    }
  for (const language of ['typescript', 'dotnet']) {
    const source = new SourceExporter(k, language).export(d);
    await writeFile(
      resolve(out, `${id}.${language === 'dotnet' ? 'cs.txt' : 'ts'}`),
      source + (language === 'typescript' ? '\nexport { document };\n' : '')
    );
    await writeFile(resolve(out, id + '.input.json'), JSON.stringify(d));
    if (language === 'dotnet') {
      const body = source
        .replace(/^using (?!var)[^\n]+\n/gm, '')
        .replace(
          'await document.SaveAsync("document.pdf");',
          `await document.SaveAsync(${JSON.stringify(resolve(out, id + '.cs.pdf'))});`
        );
      methods.push(
        `static async Task Example${i}() {\n${body}\nawait File.WriteAllTextAsync(${JSON.stringify(resolve(out, id + '.cs.json'))}, Capture(document));\nusing var baseline = await Document.FromDefinitionAsync(await File.ReadAllTextAsync(${JSON.stringify(resolve(out, id + '.input.json'))}));\nbaseline.GenerateBytes();\nawait File.WriteAllTextAsync(${JSON.stringify(resolve(out, id + '.baseline-cs.json'))}, Capture(baseline));\n}`
      );
    }
  }
}
await writeFile(
  resolve(out, 'Program.cs'),
  `using System;\nusing System.IO;\nusing System.Threading.Tasks;\nusing System.Collections.Generic;\nusing System.Globalization;\nusing System.Text;\nusing BonniePDF;\nclass NativeExportCheck {\nstatic string Capture(Document doc) { try { return doc.ToDefinition().ToJson(); } catch (DefinitionException e) { return System.Text.Json.JsonSerializer.Serialize(new { roundTripError = e.Message }); } }\nstatic async Task Main() { ${ids.map((_, i) => `await Example${i}();`).join(' ')} }\n${methods.join('\n')}\n}`
);
await writeFile(
  resolve(out, 'NativeExportCheck.csproj'),
  `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><Reference Include="BonniePDF"><HintPath>${resolve(root, '../BonniePDF-NET/BonniePDF/bin/Release/net10.0/BonniePDF.dll')}</HintPath></Reference></ItemGroup></Project>`
);
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: out, encoding: 'utf8', windowsHide: true, maxBuffer: 8_000_000 });
  if (result.status !== 0) throw new Error(result.stdout + '\n' + result.stderr);
  return result;
};
run('dotnet', ['run', '--project', 'NativeExportCheck.csproj', '-v', 'quiet']);
const tsc = resolve(root, 'node_modules/typescript/bin/tsc');
run(process.execPath, [
  tsc,
  '--ignoreConfig',
  '--target',
  'ES2023',
  '--module',
  'ESNext',
  '--moduleResolution',
  'Bundler',
  '--skipLibCheck',
  '--strict',
  ...ids.map(id => id + '.ts'),
]);
for (const id of ids) {
  run(process.execPath, [
    '--input-type=module',
    '--eval',
    `
    import {document} from ${JSON.stringify('./' + id + '.js')};
    import {fromDefinition,toDefinition} from '@bonniepdf/core/definition';
    import {readFile,writeFile} from 'node:fs/promises';
    import {registerFonts} from '../../dist/render-worker.js';
    await registerFonts('../../data');
    const baseline=await fromDefinition(JSON.parse(await readFile(${JSON.stringify(id + '.input.json')},'utf8')));
    await baseline.generateBytesAsync();
    const capture = async doc => { try { return (await toDefinition(doc)).definition; } catch(error) { return { roundTripError:error.message }; } };
    await writeFile(${JSON.stringify(id + '.ts.json')},JSON.stringify(await capture(document)));
    await writeFile(${JSON.stringify(id + '.baseline-ts.json')},JSON.stringify(await capture(baseline)));
  `,
  ]);
  const pdf = await readFile(resolve(out, 'document.pdf'));
  if (pdf.subarray(0, 5).toString() !== '%PDF-') throw new Error('Invalid TypeScript PDF');
}
const differences = [];
function clean(v) {
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => k !== 'id' && k !== '$schema')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, clean(x)])
    );
  if (typeof v === 'number') return Math.round(v * 10000) / 10000;
  return v;
}
function diff(a, b, path = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[key], b[key], path + '/' + key);
  } else differences.push({ id: currentId, path, actual: a, expected: b });
}
let currentId;
const writerLimitations = [];
for (const id of ids)
  for (const language of ['cs', 'ts']) {
    currentId = id + ':' + language;
    const actual = clean(JSON.parse(await readFile(resolve(out, id + '.' + language + '.json'), 'utf8')));
    const expected = clean(JSON.parse(await readFile(resolve(out, id + '.baseline-' + language + '.json'), 'utf8')));
    if (actual.roundTripError && expected.roundTripError)
      writerLimitations.push({ id, language, reason: actual.roundTripError });
    diff(actual, expected);
  }
await writeFile(resolve(out, 'differences.json'), JSON.stringify(differences, null, 2));
await writeFile(
  resolve(out, 'report.json'),
  JSON.stringify(
    {
      compiledAndRendered: ids,
      unsupported,
      roundTripComparisons: ids.length * 2 - writerLimitations.length,
      writerLimitations,
      differences,
    },
    null,
    2
  )
);
console.log('Round-trip differences:', differences.length);
if (differences.length) throw new Error('Native round-trip differs; inspect out/native-exports/differences.json');
console.log(`Native C# and TypeScript compiled and rendered ${ids.length} document(s).`);
