import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, describe, it } from 'node:test';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CLI = join(ROOT, 'src/cli.ts');
const SERVE = join(ROOT, 'fixtures/serve.mjs');

/**
 * Chaque dossier d'exemples, l'application de démonstration qu'il vise et
 * l'état qu'il demande. Un dossier = une application : la documentation fait
 * lancer `run examples/` contre la boutique, et un parcours de la médiathèque
 * rangé à côté le faisait échouer, alors que chaque fichier, pris seul, était
 * vert.
 */
const FOLDERS: Record<string, { app: string; states?: string }> = {
  'examples': { app: 'shop', states: './examples/states-example.ts' },
  'examples/library': { app: 'library' },
};

async function scenarioFolders(dir: string): Promise<string[]> {
  const entries = await readdir(join(ROOT, dir), { withFileTypes: true });
  const own = entries.some((entry) => entry.isFile() && entry.name.endsWith('.qai.yaml')) ? [dir] : [];
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => scenarioFolders(join(dir, entry.name))),
  );
  return [...own, ...nested.flat()];
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const servers: ChildProcess[] = [];

/** Le serveur de `npm run demo`, tel quel : la boutique a un vrai endpoint réseau. */
async function demo(app: string): Promise<string> {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVE, '--app', app, '--port', String(port)], { cwd: ROOT });
  servers.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`demo ${app} exited with ${code}`)));
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('http://')) resolve();
    });
  });
  return `http://127.0.0.1:${port}/`;
}

after(() => {
  for (const child of servers) child.kill();
});

describe('les dossiers d\'exemples', () => {
  it('sont tous déclarés ici, avec leur application', async () => {
    const found = (await scenarioFolders('examples')).sort();
    assert.deepEqual(found, Object.keys(FOLDERS).sort());
  });

  for (const [dir, { app, states }] of Object.entries(FOLDERS)) {
    it(`${dir}/ rejoue en entier, vert, contre la démo « ${app} »`, { timeout: 120_000 }, async () => {
      const baseUrl = await demo(app);
      const args = [CLI, 'run', `${dir}/`, '--base-url', baseUrl, ...(states ? ['--states', states] : [])];
      const { stdout } = await run(process.execPath, args, { cwd: ROOT, timeout: 110_000 }).catch(
        (error: { stdout?: string; stderr?: string }) => {
          assert.fail(`qai run ${dir}/ failed:\n${error.stdout ?? ''}${error.stderr ?? ''}`);
        },
      );
      assert.match(stdout, /journey\(s\) — PASSED/);
      assert.doesNotMatch(stdout, /FAILED/);
    });
  }
});
