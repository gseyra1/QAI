import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    <select aria-label="Transporteur">
      <option value="std">Livraison standard</option>
      <option value="exp">Livraison express</option>
    </select>
    <button id="supprimer">Supprimer le compte</button>
    <button id="renommer">Renommer</button>
    <p data-testid="etat">intact</p>
    <button id="casser">Charger la liste</button>
    <input type="file" id="piece" data-testid="piece-jointe" style="display:none">
    <p data-testid="depose">aucun fichier</p>
    <div id="explication">Le code postal est requis</div>
    <button id="eleves"><span role="img" aria-label="team" style="display:inline-flex"></span>Membres</button>
    <button id="envoyer">Envo<b>yer</b></button>
    <button id="decoratif"><img src="data:," alt=""> Exporter</button>
    <button id="cache"><span style="display:none">Masquer</span>Afficher</button>
    <button id="ghost"><span style="visibility:hidden">Fantome</span>Valider tout</button>
    <button id="saut">ligne1<br>ligne2</button>
    <button id="entre">Enregistrer<span style="display:none">X</span>le brouillon</button>
    <button id="icone"><i title="Fermer"></i>Panneau</button>
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
    const etat = document.querySelector('[data-testid=etat]');
    document.getElementById('supprimer').addEventListener('click', () => {
      etat.textContent = confirm('Confirmer la suppression ?') ? 'supprimé' : 'intact';
    });
    document.getElementById('renommer').addEventListener('click', () => {
      etat.textContent = prompt('Nouveau nom ?') ?? 'annulé';
    });
    document.getElementById('casser').addEventListener('click', () => {
      fetch('/api/casse');
      console.error('appel en echec');
      console.warn('juste un avertissement');
    });
    document.getElementById('piece').addEventListener('change', (e) => {
      document.querySelector('[data-testid=depose]').textContent =
        [...e.target.files].map((f) => f.name).join(', ');
    });
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
    server = createServer((req, res) => {
      // Un endpoint qui refuse : c'est la panne que l'observation doit voir.
      if (req.url?.startsWith('/api/casse') === true) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"erreur":"boum"}');
        return;
      }
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

  /**
   * Le texte écrit dans un `div` était invisible : `group` n'est pas un rôle
   * dont accname déduit le nom, donc le nœud sortait avec un nom vide. C'est
   * le rendu par défaut de la plupart des bibliothèques de composants — antd y
   * met ses messages de validation, ce qui rendait « le formulaire refuse une
   * saisie vide » inexprimable.
   */
  it('voit le texte porté par un conteneur générique', async () => {
    const snapshot = await driver.observe();
    const trouve = findAll(snapshot.root, (n) => n.name === 'Le code postal est requis');

    assert.equal(trouve.length, 1);
    assert.equal(trouve[0]?.role, 'text');
  });

  /**
   * L'arbre observé sert à formuler la cible ; c'est Playwright qui la
   * résout, avec le calcul du navigateur. Les deux doivent donc nommer
   * pareil — sinon le modèle recopie fidèlement un nom que la résolution
   * rejettera toujours.
   */
  it('fait contribuer le libellé d\'une icône au nom de son bouton', async () => {
    const snapshot = await driver.observe();

    // Ce que le navigateur calcule, et donc ce que Playwright cherchera.
    assert.equal(findAll(snapshot.root, (n) => n.name === 'team Membres').length, 1);
  });

  it('n\'insère pas de séparateur autour d\'un descendant en ligne', async () => {
    const snapshot = await driver.observe();

    // Joindre inconditionnellement donnerait « Envo yer » : un nom que le
    // navigateur ne calcule jamais, donc une cible impossible à viser.
    assert.equal(findAll(snapshot.root, (n) => n.name === 'Envoyer').length, 1);
    assert.equal(findAll(snapshot.root, (n) => n.name === 'Envo yer').length, 0);
  });

  it('exclut du nom un descendant masqué par le rendu, comme accname', async () => {
    const snapshot = await driver.observe();

    // « display:none » et « visibility:hidden » ne sont pas dans le nom
    // accessible : les inclure donnait « Masquer Afficher », introuvable.
    assert.equal(findAll(snapshot.root, (n) => n.name === 'Afficher').length, 1);
    assert.equal(findAll(snapshot.root, (n) => n.name === 'Masquer Afficher').length, 0);
    assert.equal(findAll(snapshot.root, (n) => n.name === 'Valider tout').length, 1);
    assert.equal(findAll(snapshot.root, (n) => n.name === 'Fantome Valider tout').length, 0);
  });

  it('compte un <br> comme une espace, comme accname', async () => {
    const snapshot = await driver.observe();

    assert.equal(findAll(snapshot.root, (n) => n.name === 'ligne1 ligne2').length, 1);
    assert.equal(findAll(snapshot.root, (n) => n.name === 'ligne1ligne2').length, 0);
  });

  it('traite display:none comme une espace entre deux textes, contrairement à visibility:hidden', async () => {
    const snapshot = await driver.observe();

    // display:none retire l'élément du flux → le navigateur garde une espace.
    assert.equal(findAll(snapshot.root, (n) => n.name === 'Enregistrer le brouillon').length, 1);
    assert.equal(findAll(snapshot.root, (n) => n.name === 'Enregistrerle brouillon').length, 0);
    // visibility:hidden colle les voisins → pas d'espace.
    assert.equal(findAll(snapshot.root, (n) => n.name === 'Valider tout').length, 1);
  });

  it('fait contribuer le title d\'une icône sans texte au nom, comme accname', async () => {
    const snapshot = await driver.observe();

    assert.equal(findAll(snapshot.root, (n) => n.name === 'FermerPanneau').length, 1);
    assert.equal(findAll(snapshot.root, (n) => n.name === 'Panneau').length, 0);
  });

  /**
   * La preuve dure : le nom observé et le calcul de Playwright convergent. On
   * observe le nom, puis on le résout par ce même nom — si l'observation
   * divergeait, getByRole ne trouverait rien. C'était le défaut central de la
   * v2, prouvé faux ici pour chaque cas piégeux.
   */
  it('résout chaque nom piégeux par le calcul de Playwright', async () => {
    const noms = [
      'team Membres',
      'Envoyer',
      'Afficher',
      'Valider tout',
      'ligne1 ligne2',
      'Enregistrer le brouillon',
      'FermerPanneau',
    ];
    for (const name of noms) {
      const outcome = await driver.resolve({ primary: { role: 'button', name } });
      assert.equal(outcome.found, true, `getByRole must find "${name}"`);
    }
  });

  it('ignore une image décorative, dont l\'alt est vide', async () => {
    const snapshot = await driver.observe();
    assert.equal(findAll(snapshot.root, (n) => n.name === 'Exporter').length, 1);
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

  /**
   * `selectOption(string)` apparie la *value*, un détail technique invisible
   * de l'utilisateur. Un outil d'intention doit viser le libellé affiché —
   * mais les résolutions déjà écrites par valeur doivent continuer à jouer,
   * d'où les deux sens vérifiés ici.
   */
  it('choisit une option par son libellé, et encore par sa valeur', async () => {
    const cible = { primary: { role: 'combobox' as const, name: 'Transporteur' } };
    const valeur = async (): Promise<string> => {
      const outcome = await driver.resolve(cible);
      return outcome.found ? (outcome.node.value ?? '') : '';
    };

    await driver.act({ kind: 'select', target: cible, option: 'Livraison express' });
    assert.equal(await valeur(), 'exp', 'le libellé affiché doit suffire');

    await driver.act({ kind: 'select', target: cible, option: 'std' });
    assert.equal(await valeur(), 'std', 'une résolution écrite par valeur doit continuer à jouer');
  });

  /**
   * Playwright refuse automatiquement tout dialogue natif tant que personne
   * n'écoute. Un parcours « supprimer puis confirmer » se déroulait donc sans
   * erreur mais sans rien supprimer — le pire des cas : un vert qui ne prouve
   * rien.
   */
  describe('dialogues natifs', () => {
    const etat = async (): Promise<string> => {
      const outcome = await driver.resolve({
        primary: { role: 'text', name: 'Libellé absent' },
        fallback: { testId: 'etat' },
      });
      return outcome.found ? outcome.node.name : '';
    };

    const supprimer = { primary: { role: 'button' as const, name: 'Supprimer le compte' } };

    it('accepte la confirmation quand elle est armée', async () => {
      await driver.act({ kind: 'expectDialog', response: 'accept' });
      await driver.act({ kind: 'click', target: supprimer });
      await driver.settle();

      assert.equal(await etat(), 'supprimé');
      assert.equal(driver.takePendingDialogs(), 0, 'la politique doit avoir été consommée');
    });

    it('refuse la confirmation, et par défaut aussi', async () => {
      await driver.act({ kind: 'expectDialog', response: 'dismiss' });
      await driver.act({ kind: 'click', target: supprimer });
      await driver.settle();
      assert.equal(await etat(), 'intact');

      // Aucune politique armée : le comportement d'avant est conservé.
      await driver.act({ kind: 'click', target: supprimer });
      await driver.settle();
      assert.equal(await etat(), 'intact');
    });

    it('répond à un prompt avec le texte demandé', async () => {
      await driver.act({ kind: 'expectDialog', response: 'accept', promptText: 'Nouveau libellé' });
      await driver.act({ kind: 'click', target: { primary: { role: 'button', name: 'Renommer' } } });
      await driver.settle();

      assert.equal(await etat(), 'Nouveau libellé');
    });

    it('rend et efface une politique jamais consommée', async () => {
      await driver.act({ kind: 'expectDialog', response: 'accept' });
      assert.equal(driver.takePendingDialogs(), 1);
      assert.equal(driver.takePendingDialogs(), 0, 'la lecture doit aussi désarmer');
    });
  });

  /**
   * Le champ de téléversement est presque toujours masqué derrière un bouton
   * stylé. `setInputFiles` accepte l'élément invisible là où un clic échouerait
   * — sans quoi tout import, avatar ou pièce jointe reste intestable.
   */
  it('dépose un fichier dans un champ masqué', async () => {
    const dossier = await mkdtemp(join(tmpdir(), 'qai-upload-'));
    const fichier = join(dossier, 'releve.txt');
    await writeFile(fichier, 'contenu');

    try {
      await driver.act({
        kind: 'upload',
        target: { primary: { role: 'unknown', name: 'introuvable' }, fallback: { testId: 'piece-jointe' } },
        files: [fichier],
      });
      await driver.settle();

      const outcome = await driver.resolve({
        primary: { role: 'text', name: 'Libellé absent' },
        fallback: { testId: 'depose' },
      });
      assert.equal(outcome.found && outcome.node.name, 'releve.txt');
    } finally {
      await rm(dossier, { recursive: true, force: true });
    }
  });

  /**
   * Sans ces observations, un écran vide parce qu'un appel a rendu 500 est
   * indiscernable d'un écran vide parce qu'il n'y a rien à montrer — et le
   * rapport dit « élément introuvable » là où la cause est ailleurs.
   */
  it('observe les requêtes en échec et les erreurs console', async () => {
    driver.drainObservations();

    await driver.act({
      kind: 'click',
      target: { primary: { role: 'button', name: 'Charger la liste' } },
    });
    await driver.settle();

    const { network, console: journal } = driver.drainObservations();

    const casse = network.find((entry) => entry.url.includes('/api/casse'));
    assert.equal(casse?.status, 500);
    assert.equal(casse?.method, 'GET');

    assert.ok(journal.some((e) => e.level === 'error' && e.text.includes('appel en echec')));
    assert.ok(journal.some((e) => e.level === 'warning'), 'les avertissements sont aussi collectés');

    assert.deepEqual(driver.drainObservations(), { network: [], console: [] }, 'la lecture doit vider');
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
