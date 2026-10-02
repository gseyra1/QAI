import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import type { UINode } from '../src/driver/types.ts';
import { PlaywrightWebDriver } from '../src/driver/web/PlaywrightWebDriver.ts';
import { renderTree } from '../src/generate/render.ts';

/**
 * Mesure le poids de l'arbre d'interface d'une page.
 *
 * C'est l'entrée du calcul de coût : l'arbre est ce qu'on envoie au modèle à
 * chaque réparation, donc sa taille détermine le prix d'un run dégradé.
 *
 *   npm run measure -- --url https://mon-app.example/
 */
const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    viewport: { type: 'string', default: '1280x800' },
    print: { type: 'boolean', default: false },
  },
});

if (values.url === undefined) {
  process.stderr.write('usage: npm run measure -- --url <url> [--viewport 1280x800] [--print]\n');
  process.exit(1);
}

const [width = 1280, height = 800] = values.viewport.split('x').map(Number);

function count(node: UINode): number {
  return 1 + node.children.reduce((total, child) => total + count(child), 0);
}

function sizes(root: UINode): { nodes: number; full: number; lean: number } {
  const full = JSON.stringify(root).length;
  const lean = JSON.stringify(root, (key, value) =>
    key === 'rect' || key === 'id' ? undefined : (value as unknown),
  ).length;
  return { nodes: count(root), full, lean };
}

const driver = new PlaywrightWebDriver(() => chromium.launch());
try {
  await driver.launch({ entry: values.url, viewport: { width, height } });
  await driver.settle();

  if (values.print === true) {
    process.stdout.write(`${renderTree((await driver.observe({ interactiveOnly: true })).root)}\n\n`);
  }

  const complete = sizes((await driver.observe()).root);
  const interactive = sizes((await driver.observe({ interactiveOnly: true })).root);
  const shot = await driver.observe({ screenshot: true });

  process.stdout.write(
    [
      `${values.url}  (${width}x${height})`,
      '',
      `full tree              ${String(complete.nodes).padStart(5)} nodes  ${String(complete.full).padStart(7)} chars`,
      `  without rect or id   ${' '.repeat(5)}         ${String(complete.lean).padStart(7)} chars`,
      `interactive tree only  ${String(interactive.nodes).padStart(5)} nodes  ${String(interactive.full).padStart(7)} chars`,
      `  without rect or id   ${' '.repeat(5)}         ${String(interactive.lean).padStart(7)} chars`,
      `screenshot             ${((shot.screenshot?.byteLength ?? 0) / 1024).toFixed(0)} KiB`,
      '',
      'Characters are not tokens: count real tokens with your provider\'s API',
      'before setting a budget.',
      '',
    ].join('\n'),
  );
} finally {
  await driver.dispose();
}
