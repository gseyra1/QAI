import { chromium } from 'playwright';
import { PlaywrightWebDriver } from '../src/driver/web/PlaywrightWebDriver.ts';
import { renderTree } from '../src/generate/render.ts';

/**
 * Sonde ANONYME du formulaire de connexion : validation à vide, puis refus
 * d'identifiants faux. Aucun secret — le mot de passe employé est
 * délibérément invalide, c'est ce qu'on cherche à provoquer.
 */
const BASE = process.env['QAI_BASE'] ?? 'http://localhost:3000';
const attendre = (ms: number) => new Promise((r) => setTimeout(r, ms));

const driver = new PlaywrightWebDriver(() => chromium.launch());
try {
  await driver.launch({ entry: `${BASE}/login`, viewport: { width: 1280, height: 800 } });
  await driver.settle();
  await attendre(7000);

  process.stdout.write('===== 1. soumission à vide\n');
  await driver.act({ kind: 'click', target: { primary: { role: 'button', name: 'Se connecter' } } });
  await driver.settle();
  await attendre(1500);
  process.stdout.write(`${renderTree((await driver.observe({ interactiveOnly: true })).root)}\n\n`);

  process.stdout.write('===== 2. identifiants refusés par tc_identity\n');
  await driver.act({
    kind: 'fill',
    target: { primary: { role: 'textbox', name: 'Identifiant ou email' } },
    value: 'compte.inexistant.qai',
  });
  await driver.act({
    kind: 'fill',
    target: { primary: { role: 'textbox', name: 'Mot de passe' } },
    value: 'mot-de-passe-volontairement-faux',
  });
  driver.drainObservations();
  await driver.act({ kind: 'click', target: { primary: { role: 'button', name: 'Se connecter' } } });
  await driver.settle();
  await attendre(900);

  const snapshot = await driver.observe();
  const obs = driver.drainObservations();
  process.stdout.write(`URL : ${snapshot.location}\n`);
  process.stdout.write(
    `réseau : ${obs.network.map((e) => `${e.method} ${e.url.replace(/^https?:\/\/[^/]+/, '')} → ${e.status ?? 'KO'}`).join(' | ')}\n\n`,
  );
  process.stdout.write(`${renderTree(snapshot.root)}\n`);
} finally {
  await driver.dispose();
}
