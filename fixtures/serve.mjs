import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8899' },
    bug: { type: 'string' },
  },
});

const source = readFileSync(new URL('./shop/index.html', import.meta.url), 'utf8');
const page =
  values.bug === undefined
    ? source
    : source.replace('<head>', `<head><script>window.__QAI_BUG=${JSON.stringify(values.bug)}</script>`);

createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(page);
}).listen(Number(values.port), '127.0.0.1', () => {
  const state = values.bug === undefined ? 'healthy' : `with regression "${values.bug}"`;
  process.stdout.write(`Demo shop ${state}: http://127.0.0.1:${values.port}/\n`);
});
