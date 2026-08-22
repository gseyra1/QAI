import { chromium } from 'playwright';
import { PlaywrightWebDriver } from '../src/driver/web/PlaywrightWebDriver.ts';

/**
 * Le formulaire de connexion refuse-t-il une soumission à vide ?
 *
 * On échantillonne l'arbre pendant trois secondes après le clic : un message
 * de validation antd apparaît en quelques dizaines de millisecondes, mais une
 * observation unique peut tomber avant. Sans cet échantillonnage, on
 * conclurait à un défaut là où il n'y a qu'un mauvais instant de mesure.
 */
const BASE = process.env['QAI_BASE'] ?? 'http://localhost:3000';
const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

function noms(node: { name: string; children: { name: string }[] }): string[] {
  const out: string[] = [];
  const walk = (n: any): void => {
    if (n.name) out.push(n.name);
    for (const c of n.children) walk(c);
  };
  walk(node);
  return out;
}

const driver = new PlaywrightWebDriver(() => chromium.launch());
try {
  await driver.launch({ entry: `${BASE}/login`, viewport: { width: 1280, height: 800 } });
  await driver.settle();
  await attendre(7000);

  await driver.act({ kind: 'click', target: { primary: { role: 'button', name: 'Se connecter' } } });

  for (let i = 0; i < 12; i += 1) {
    await attendre(250);
    const tous = noms((await driver.observe()).root as never);
    const trouves = tous.filter((n) => /requis|obligatoire|invalide/i.test(n));
    process.stdout.write(`${(i + 1) * 250} ms → ${trouves.length > 0 ? trouves.join(' | ') : '(rien)'}\n`);
  }

  // Second cas : un seul champ rempli, l'autre vide.
  process.stdout.write('\n--- identifiant seul, mot de passe vide\n');
  await driver.act({
    kind: 'fill',
    target: { primary: { role: 'textbox', name: 'Identifiant ou email' } },
    value: 'quelquun',
  });
  await driver.act({ kind: 'click', target: { primary: { role: 'button', name: 'Se connecter' } } });
  for (let i = 0; i < 8; i += 1) {
    await attendre(250);
    const tous = noms((await driver.observe()).root as never);
    const trouves = tous.filter((n) => /requis|obligatoire|invalide/i.test(n));
    process.stdout.write(`${(i + 1) * 250} ms → ${trouves.length > 0 ? trouves.join(' | ') : '(rien)'}\n`);
  }
} finally {
  await driver.dispose();
}
