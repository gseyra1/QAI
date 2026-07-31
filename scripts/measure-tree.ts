import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import type { UINode } from '../src/driver/types.ts';
import { PlaywrightWebDriver } from '../src/driver/web/PlaywrightWebDriver.ts';
import { renderTree } from '../src/generate/render.ts';

/**
 * Mesure le poids de l'arbre d'interface d'une page.
 *
 * C'est l'entrée du calcul de coût : l'arbre est ce qu'on envoie au modèle à
 * chaque réparation, donc sa taille détermine le prix d'un run dégradé. Voir
 * docs/couts.md.
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
  process.stderr.write('usage : npm run measure -- --url <url>\n');
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
      `arbre complet          ${String(complete.nodes).padStart(5)} nœuds  ${String(complete.full).padStart(7)} car.`,
      `  sans géométrie ni id ${' '.repeat(5)}         ${String(complete.lean).padStart(7)} car.`,
      `arbre interactif seul  ${String(interactive.nodes).padStart(5)} nœuds  ${String(interactive.full).padStart(7)} car.`,
      `  sans géométrie ni id ${' '.repeat(5)}         ${String(interactive.lean).padStart(7)} car.`,
      `capture d'écran        ${((shot.screenshot?.byteLength ?? 0) / 1024).toFixed(0)} Kio`,
      '',
      'Les caractères ne sont pas des jetons : compter les jetons réels avec',
      "l'API du fournisseur branché avant de figer un budget.",
      '',
    ].join('\n'),
  );
} finally {
  await driver.dispose();
}
