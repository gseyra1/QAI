import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { chromium, type Browser } from 'playwright';
import type { UINode } from '../types.ts';
import { PlaywrightWebDriver } from './PlaywrightWebDriver.ts';

const FIXTURE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Boutique</title></head>
<body>
  <header>
    <a href="/panier">Panier <span data-testid="cart-count">0</span></a>
  </header>
  <main>
    <input type="search" aria-label="Rechercher un produit">
    <input type="password" aria-label="Mot de passe" value="secret-en-clair">
    <ul aria-label="Résultats">
      <li><a href="/p/1">Chaise de bureau</a></li>
      <li><a href="/p/2">Lampe de bureau</a></li>
    </ul>
    <h1>Chaise de bureau</h1>
    <button data-testid="add-to-cart" id="add">Ajouter au panier</button>
    <button disabled>Valider</button>
    <button>Valider</button>
    <button aria-hidden="true">Fantôme</button>
    <div style="display:none"><button>Bouton masqué</button></div>
  </main>
  <p id="salut"></p>
  <script>
    document.getElementById('add').addEventListener('click', () => {
      const c = document.querySelector('[data-testid=cart-count]');
      c.textContent = String(Number(c.textContent) + 1);
    });
    // Amorçage : l'état de session n'est lu qu'au chargement, comme dans une
    // vraie application. C'est ce qui rend le rechargement d'applyState
    // observable.
    const u = localStorage.getItem('qai_user');
    if (u) document.getElementById('salut').textContent = 'Bonjour ' + u;
  </script>
</body></html>`;

function walk(node: UINode, visit: (n: UINode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

function findAll(root: UINode, predicate: (n: UINode) => boolean): UINode[] {
  const found: UINode[] = [];
  walk(root, (n) => {
    if (predicate(n)) found.push(n);
  });
  return found;
}

describe('PlaywrightWebDriver', () => {
  let server: Server;
  let driver: PlaywrightWebDriver;
  let baseUrl: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FIXTURE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

    driver = new PlaywrightWebDriver(() => chromium.launch());
    await driver.launch({ entry: baseUrl, viewport: { width: 1280, height: 800 } });
    await driver.settle();
  });

  after(async () => {
    await driver.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('normalise le DOM en rôles et noms accessibles', async () => {
    const snapshot = await driver.observe();

    assert.equal(snapshot.platform, 'web');
    assert.equal(snapshot.location, baseUrl);

    const search = findAll(snapshot.root, (n) => n.role === 'searchbox');
    assert.equal(search.length, 1);
    assert.equal(search[0]?.name, 'Rechercher un produit');

    const heading = findAll(snapshot.root, (n) => n.role === 'heading');
    assert.equal(heading[0]?.name, 'Chaise de bureau');

    const list = findAll(snapshot.root, (n) => n.role === 'list');
    assert.equal(list.length, 1);
    assert.equal(list[0]?.name, 'Résultats', 'aria-label prime sur le contenu textuel');
    assert.equal(list[0]?.children.length, 2);
  });

  it('donne à chaque nœud une géométrie exploitable', async () => {
    const snapshot = await driver.observe();
    const add = findAll(snapshot.root, (n) => n.name === 'Ajouter au panier' && n.role === 'button');
    assert.equal(add.length, 1);
    assert.ok((add[0]?.rect.width ?? 0) > 0, 'la largeur doit être mesurée');
    assert.ok((add[0]?.rect.height ?? 0) > 0, 'la hauteur doit être mesurée');
  });

  it('exclut les nœuds masqués et aria-hidden', async () => {
    const snapshot = await driver.observe();
    assert.equal(findAll(snapshot.root, (n) => n.name === 'Fantôme').length, 0);
    assert.equal(findAll(snapshot.root, (n) => n.name === 'Bouton masqué').length, 0);
  });

  it('remonte l\'identifiant de test des éléments qui en portent un', async () => {
    const snapshot = await driver.observe();
    const bouton = findAll(snapshot.root, (n) => n.name === 'Ajouter au panier');
    assert.equal(bouton[0]?.testId, 'add-to-cart');
  });

  it('ne publie jamais la valeur d\'un champ mot de passe', async () => {
    const snapshot = await driver.observe();
    const champ = findAll(snapshot.root, (n) => n.name === 'Mot de passe');
    assert.equal(champ.length, 1, 'le champ doit rester présent dans le snapshot');
    assert.equal(champ[0]?.value, undefined);
    // Le secret ne doit apparaître nulle part, pas seulement hors du champ.
    assert.equal(findAll(snapshot.root, (n) => n.value === 'secret-en-clair').length, 0);
  });

  it('remonte l\'état désactivé', async () => {
    const snapshot = await driver.observe();
    const valider = findAll(snapshot.root, (n) => n.role === 'button' && n.name === 'Valider');
    assert.equal(valider.length, 2);
    assert.equal(valider.filter((n) => n.state.disabled === true).length, 1);
  });

  it('résout une cible par rôle et nom', async () => {
    const outcome = await driver.resolve({
      primary: { role: 'button', name: 'Ajouter au panier' },
    });
    assert.equal(outcome.found, true);
    assert.ok(outcome.found && outcome.usedFallback === false);
    assert.equal(outcome.found && outcome.node.role, 'button');
  });

  it('refuse de choisir quand plusieurs éléments correspondent', async () => {
    const outcome = await driver.resolve({ primary: { role: 'button', name: 'Valider' } });
    assert.equal(outcome.found, false);
    assert.equal(outcome.found === false && outcome.reason, 'ambiguous');
    assert.equal(outcome.found === false && outcome.matches, 2);
  });

  it('accepte la même cible une fois désambiguïsée par nth', async () => {
    const outcome = await driver.resolve({
      primary: { role: 'button', name: 'Valider', nth: 1 },
    });
    assert.equal(outcome.found, true);
    assert.equal(outcome.found && outcome.node.state.disabled, undefined);
  });

  it('bascule sur le repli et le signale', async () => {
    const outcome = await driver.resolve({
      primary: { role: 'button', name: 'Libellé qui a disparu' },
      fallback: { testId: 'add-to-cart' },
    });
    assert.equal(outcome.found, true);
    assert.equal(outcome.found && outcome.usedFallback, true);
  });

  it('signale une cible absente sans repli', async () => {
    const outcome = await driver.resolve({
      primary: { role: 'button', name: 'Libellé qui a disparu' },
    });
    assert.equal(outcome.found, false);
    assert.equal(outcome.found === false && outcome.reason, 'no-match');
  });

  it('cible à l\'intérieur d\'un conteneur', async () => {
    const outcome = await driver.resolve({
      primary: {
        role: 'link',
        name: 'Lampe de bureau',
        within: { role: 'list', name: 'Résultats' },
      },
    });
    assert.equal(outcome.found, true);
  });

  it('agit sur la page et le résultat est observable', async () => {
    await driver.act({
      kind: 'click',
      target: { primary: { role: 'button', name: 'Ajouter au panier' } },
    });
    await driver.settle();

    const outcome = await driver.resolve({
      primary: { role: 'text', name: 'Libellé absent' },
      fallback: { testId: 'cart-count' },
    });
    assert.equal(outcome.found, true);
    assert.equal(outcome.found && outcome.node.name, '1');
  });

  it('refuse une action que la plateforme ne sait pas faire', async () => {
    assert.equal(driver.capabilities.swipe, false);
    await assert.rejects(
      () => driver.act({ kind: 'swipe', direction: 'up' }),
      (error: unknown) => error instanceof Error && error.message.includes('swipe'),
    );
  });
  /**
   * Le mappage des cookies n'etait couvert nulle part. Un attribut perdu ici ne
   * casse aucun test : il produit une session muette, donc un parcours qui
   * demarre anonyme et echoue plusieurs etapes plus loin sur une assertion sans
   * rapport. C'est precisement le defaut le plus couteux a diagnostiquer.
   *
   * Le pilote recoit son lanceur par injection : le test s'en sert pour garder
   * une reference sur le navigateur, sans elargir l'API publique de la classe.
   */
  it('pose un cookie inter-site avec ses attributs Secure et SameSite', async () => {
    let browser: Browser | null = null;
    const local = new PlaywrightWebDriver(async () => {
      browser = await chromium.launch();
      return browser;
    });

    try {
      await local.launch({ entry: baseUrl, viewport: { width: 800, height: 600 } });
      await local.applyState({
        cookies: [{
          name: 'tc_session', value: 'jeton-de-test',
          domain: '127.0.0.1', path: '/',
          secure: true, sameSite: 'None',
        }],
      });

      const context = (browser as unknown as Browser).contexts()[0];
      assert.ok(context, 'le contexte doit exister');
      const session = (await context.cookies()).find((c) => c.name === 'tc_session');

      assert.ok(session, 'le cookie doit avoir ete pose');
      assert.equal(session.value, 'jeton-de-test');
      assert.equal(session.sameSite, 'None');
      assert.equal(session.secure, true);
    } finally {
      await local.dispose();
    }
  });

  it('recharge la page quand un état est posé sans point d\'entrée', async () => {
    // launch() charge la page AVANT applyState : l'amorçage de l'application a
    // déjà lu un storage vide. Sans rechargement, l'app resterait rendue
    // « déconnectée » pour toute la durée du parcours.
    const local = new PlaywrightWebDriver(() => chromium.launch());

    try {
      await local.launch({ entry: baseUrl, viewport: { width: 800, height: 600 } });
      await local.applyState({ storage: { qai_user: 'Alice' } });

      const snapshot = await local.observe();
      assert.equal(findAll(snapshot.root, (n) => n.name === 'Bonjour Alice').length, 1);
    } finally {
      await local.dispose();
    }
  });

  it('laisse le navigateur decider quand Secure et SameSite sont omis', async () => {
    let browser: Browser | null = null;
    const local = new PlaywrightWebDriver(async () => {
      browser = await chromium.launch();
      return browser;
    });

    try {
      await local.launch({ entry: baseUrl, viewport: { width: 800, height: 600 } });
      await local.applyState({
        cookies: [{ name: 'sans_attributs', value: 'x', domain: '127.0.0.1', path: '/' }],
      });

      const context = (browser as unknown as Browser).contexts()[0];
      assert.ok(context);
      const cookie = (await context.cookies()).find((c) => c.name === 'sans_attributs');

      // Comportement inchange pour les appelants qui ne se prononcent pas.
      assert.ok(cookie, 'omettre les attributs ne doit pas empecher la pose');
      assert.equal(cookie.value, 'x');
    } finally {
      await local.dispose();
    }
  });
});
