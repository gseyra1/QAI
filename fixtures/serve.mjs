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

createServer((request, response) => {
  /**
   * Un vrai endpoint, pour que l'observation du réseau ait quelque chose à
   * observer. Avec « --bug reco-500 » il refuse : l'écran reste correct — la
   * liste est simplement vide — et seul le réseau distingue « rien à
   * recommander » de « l'appel a cassé ». C'est exactement la panne qu'aucune
   * assertion sur l'arbre ne peut voir.
   */
  if (request.url?.startsWith('/api/recommandations')) {
    const broken = values.bug === 'reco-500';
    response.writeHead(broken ? 500 : 200, { 'content-type': 'application/json' });
    response.end(broken ? '{"erreur":"service indisponible"}' : '["Tapis de souris","Repose-poignets"]');
    return;
  }

  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(page);
}).listen(Number(values.port), '127.0.0.1', () => {
  const state = values.bug === undefined ? 'saine' : `avec la régression « ${values.bug} »`;
  process.stdout.write(`Boutique de démonstration ${state} : http://127.0.0.1:${values.port}/\n`);
});
