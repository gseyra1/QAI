import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { PlaywrightWebDriver } from '../src/driver/web/PlaywrightWebDriver.ts';
import { renderTree } from '../src/generate/render.ts';

/**
 * Sonde ANONYME : aucune connexion, donc aucun secret.
 *
 * Elle sert à écrire à la main les résolutions de la suite « visiteur » — celle
 * qui peut tourner sans identifiants. Elle imprime l'arbre réel, l'URL finale
 * après redirection, et ce que le réseau a fait pendant le chargement.
 */
const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:3000' },
    wait: { type: 'string', default: '7000' },
  },
});

const ROUTES = [
  '/login',
  '/',
  '/eleves',
  '/paiements',
  '/students/12',
  '/students/12?tab=paiements',
  '/route-qui-nexiste-pas',
];

const driver = new PlaywrightWebDriver(() => chromium.launch());
try {
  await driver.launch({ entry: `${values.base}/login`, viewport: { width: 1280, height: 800 } });

  for (const route of ROUTES) {
    await driver.act({ kind: 'navigate', to: route });
    await driver.settle();
    // Le garde de route affiche un Spin tant que /me n'a pas répondu : observer
    // au repos réseau ne verrait qu'un conteneur vide.
    await new Promise((r) => setTimeout(r, Number(values.wait)));
    await driver.settle();

    const snapshot = await driver.observe({ interactiveOnly: true });
    const obs = driver.drainObservations();
    const echecs = obs.network.filter((e) => e.status === null || e.status >= 400);

    process.stdout.write(`\n===== demandé ${route}\n`);
    process.stdout.write(`URL finale : ${snapshot.location}\n`);
    process.stdout.write(
      `réseau en échec : ${echecs.map((e) => `${e.method} ${e.url} → ${e.status ?? 'KO'}`).join(' | ') || 'aucun'}\n`,
    );
    process.stdout.write(
      `console : ${obs.console.map((c) => `[${c.level}] ${c.text}`).join(' | ').slice(0, 300) || 'silencieuse'}\n\n`,
    );
    process.stdout.write(`${renderTree(snapshot.root)}\n`);
  }
} finally {
  await driver.dispose();
}
