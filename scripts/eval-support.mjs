import { readFile } from 'node:fs/promises';

const call = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${result.content[0]?.text}`);
  return result.structuredContent;
};

export async function score(client, brief, trace, answer = '') {
  const failures = [];
  const { documents } = await call(client, 'list_documents', {});
  if (!documents.length) return { failures: ['no document was created'] };
  const touched = trace
    .filter(t => !t.isError)
    .map(t => t.documentId ?? t.arguments?.documentId)
    .filter(Boolean);
  const documentId = touched.at(-1) ?? documents.at(-1).documentId;
  const read = await call(client, 'get_document', { documentId, maxChars: 16000 });
  const parts = [read.text];
  for (let offset = read.nextOffset; offset !== null;) {
    const next = await call(client, 'get_document', { documentId, offset, maxChars: 16000 });
    parts.push(next.text);
    offset = next.nextOffset;
  }
  const definition = JSON.parse(parts.join(''));
  const checks = brief.checks;
  for (const text of checks.contains ?? [])
    if (!JSON.stringify(definition).includes(text)) failures.push(`missing text "${text}"`);
  for (const [pointer, expected] of Object.entries(checks.pointerEquals ?? {})) {
    const value = await call(client, 'get_document', { documentId, pointer }).catch(() => undefined);
    if (!value || JSON.parse(value.text) !== expected) failures.push(`${pointer} is not "${expected}"`);
  }
  for (const type of checks.types ?? []) {
    if (!(await call(client, 'find_elements', { documentId, type })).total) failures.push(`no ${type} element`);
  }
  if (checks.lastText) {
    const all = await call(client, 'find_elements', { documentId, limit: 100 });
    const last = all.matches.filter(m => m.text).at(-1);
    if (!last?.text.includes(checks.lastText))
      failures.push(`last text is "${last?.text}", expected "${checks.lastText}"`);
  }
  if (!(await call(client, 'validate_definition', { documentId })).valid) failures.push('definition invalid');
  if (checks.pdf) {
    const pdf = trace.findLast(t => !t.isError && t.documentId === documentId && t.pdf);
    if (!pdf?.artifactPath) failures.push('no PDF was generated for this document');
    else {
      const lastEdit = trace.findLastIndex(
        t =>
          !t.isError &&
          (t.documentId ?? t.arguments?.documentId) === documentId &&
          ['create_document', 'patch_document', 'patch_and_preview'].includes(t.tool)
      );
      if (lastEdit > trace.indexOf(pdf)) failures.push('PDF was generated before the final edit');
      const bytes = await readFile(pdf.artifactPath).catch(() => undefined);
      if (!bytes || bytes.subarray(0, 5).toString() !== '%PDF-') failures.push('returned PDF is missing or invalid');
      if (checks.returnedPath && !answer.replace(/\\+/g, '/').includes(pdf.artifactPath.replace(/\\+/g, '/')))
        failures.push('the final answer does not contain the saved PDF path');
    }
  }
  return { documentId, failures };
}

export function summarize(rows) {
  return [...new Set(rows.map(r => `${r.model}\0${r.profile}`))].map(key => {
    const mine = rows.filter(r => `${r.model}\0${r.profile}` === key);
    const measured = mine.filter(r => r.tokenCountsComplete);
    const average = (list, field) =>
      list.length ? Math.round(list.reduce((n, r) => n + (r[field] ?? 0), 0) / list.length) : null;
    return {
      model: mine[0].model,
      profile: mine[0].profile,
      passed: `${mine.filter(r => r.passed).length}/${mine.length}`,
      measuredRuns: measured.length,
      avgPromptTokens: average(measured, 'promptTokens'),
      avgOutputTokens: average(measured, 'outputTokens'),
      avgToolCalls: average(mine, 'toolCalls'),
      avgSeconds: average(mine, 'seconds'),
    };
  });
}
