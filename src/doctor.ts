import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { connectionStatus, defaultContext, type ConnectionOptions, type SetupContext } from './clients.js';

/** Exercise the installed executable over stdio, including its worker and native PNG dependency. */
export async function diagnose(context: SetupContext = defaultContext(), connection?: ConnectionOptions) {
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('BonniePDF MCP requires Node.js 24 or later. Reinstall the bundled runtime.');
  const directory = join(context.stateDir, 'doctor');
  await mkdir(directory, { recursive: true });
  const transport = new StdioClientTransport({
    command: context.executable,
    args: [context.entryPoint, 'serve', '--out-dir', directory, '--license', 'evaluation', '--profile', 'full'],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bonniepdf-doctor', version: '1.0.0' });
  let log = '';
  transport.stderr?.on('data', chunk => {
    log = (log + chunk).slice(-2000);
  });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args }, { timeout: 90000 });
    if (response.isError) throw new Error(`${name}: ${JSON.stringify(response.structuredContent ?? response.content)}`);
    return response.structuredContent as Record<string, any>;
  };
  try {
    await client.connect(transport, { timeout: 30000 });
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    for (const name of ['create_document', 'patch_and_preview', 'render_pdf', 'export_definition']) {
      if (!tools.includes(name)) throw new Error(`Server did not expose ${name}.`);
    }
    const capabilities = await call('get_capabilities');
    const document = await call('create_document', {
      definition: {
        version: 1,
        minorVersion: 0,
        settings: { accessibility: 'pdf/ua-1', language: 'en-GB' },
        metadata: { title: 'BonniePDF MCP connection test' },
        pages: [{ content: [{ type: 'Heading', text: 'BonniePDF MCP is ready', level: 1 }] }],
      },
    });
    if (!document.valid) throw new Error('The connection-test document did not validate.');
    const preview = await call('preview_definition', { documentId: document.documentId, includeImages: true });
    if (preview.warnings.length || !preview.previews[0]?.png)
      throw new Error('PNG preview failed. Reinstall the package for this Windows architecture.');
    const pdf = await call('render_pdf', { documentId: document.documentId });
    if ((await readFile(pdf.artifact.path)).subarray(0, 5).toString() !== '%PDF-')
      throw new Error('The test PDF is invalid.');
    const exported = await call('export_definition', { documentId: document.documentId });
    if (JSON.parse(await readFile(exported.artifact.path, 'utf8')).version !== 1)
      throw new Error('JSON export failed.');
    await call('delete_document', { documentId: document.documentId });
    return {
      ok: true,
      runtime: process.version,
      platform: process.platform,
      architecture: process.arch,
      coreVersion: capabilities.coreVersion,
      tools: tools.length,
      checks: [
        'stdio handshake',
        'knowledge bundle',
        'document validation',
        'PNG preview',
        'PDF rendering',
        'JSON export',
      ],
      pdf: pdf.artifact.path,
      preview: preview.previews[0].png.path,
      ...(connection ? { clientConfiguration: connectionStatus(connection, context) } : {}),
      message:
        'The installed server works. Client configuration and any client approval are separate from this self-test.',
    };
  } catch (error) {
    throw new Error(`${(error as Error).message}${log ? `\nServer details: ${log}` : ''}`);
  } finally {
    await client.close();
    await transport.close();
  }
}
