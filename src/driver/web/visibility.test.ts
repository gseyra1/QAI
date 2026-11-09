import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright';
import { evaluateCheck } from '../../engine/assert.ts';
import { renderTree } from '../../generate/render.ts';
import type { Check } from '../../resolution/types.ts';
import type { Locator, UINode } from '../types.ts';
import { PlaywrightWebDriver } from './PlaywrightWebDriver.ts';

/**
 * Une boîte vide ne dit pas, à elle seule, si son contenu se voit.
 *
 * `display:contents` et un conteneur de flottants mesurent 0 et montrent leurs
 * enfants ; un accordéon replié mesure 0 et les cache. Dans les deux cas les
 * enfants gardent leur propre boîte. Avant, le premier cas sortait du rendu
 * envoyé au modèle — le rendu écarte un nœud invisible avec ses descendants —,
 * et le second passait `visible` au vert alors que personne ne voit rien.
 *
 * Tout est vérifié sur Chromium : ce sont ses boîtes qui font la différence,
 * aucun DOM factice ne les calcule.
 */
const PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Visibilité</title></head>
<body>
  <div data-testid="contents" style="display:contents"><button>Dans un contents</button></div>
  <div data-testid="contents-texte" style="display:contents">Texte sans boîte</div>
  <button style="display:contents" onclick="document.title = 'cliqué'">Bouton sans boîte</button>
  <div data-testid="flottants"><button style="float:left">Flottant</button></div>
  <div style="clear:both"></div>

  <div data-testid="accordeon" style="height:0;overflow:hidden">
    <p>Détail replié</p>
    <button>Action repliée</button>
  </div>
  <div data-testid="deborde" style="height:0;overflow-x:clip;overflow-y:visible"><p>Déborde vers le bas</p></div>

  <div data-testid="masque" style="visibility:hidden">
    <p>Texte masqué</p>
    <button>Action masquée</button>
    <p style="visibility:visible">Texte remis</p>
  </div>

  <div data-testid="transparent" style="opacity:0">
    <p>Texte transparent</p>
    <button>Action transparente</button>
  </div>

  <div style="height:0;overflow:hidden"><p style="position:absolute;top:600px">Échappe en absolu</p></div>
  <div style="height:0;overflow:hidden;position:relative"><p style="position:absolute;top:0">Retenu en absolu</p></div>
  <div style="height:0;overflow:hidden"><p style="position:fixed;bottom:0">Échappe en fixe</p></div>
  <div style="height:0;overflow:hidden"><section><div><p style="position:absolute;top:650px">Échappe de loin</p></div></section></div>

  <details><summary>Plus de détails</summary><p>Détail fermé</p><span style="display:contents">Texte fermé</span></details>

  <div style="opacity:0"><section>
    <dialog id="modale"><p>Dans la modale</p><button onclick="this.closest('dialog').close()">Fermer</button></dialog>
  </section></div>
  <button onclick="document.getElementById('modale').showModal()">Ouvrir la modale</button>
</body></html>`;

function flatten(node: UINode): UINode[] {
  return [node, ...node.children.flatMap(flatten)];
}

function byTestId(root: UINode, testId: string): UINode | undefined {
  return flatten(root).find((node) => node.testId === testId);
}

function byName(root: UINode, name: string): UINode[] {
  return flatten(root).filter((node) => node.name === name);
}

function check(root: UINode, kind: 'visible' | 'absent', target: Locator): boolean {
  const result = evaluateCheck({ check: kind, target } as Check, { root, location: '', bag: {} });
  return result.ok;
}

describe('visibilité observée sur Chromium', () => {
  let server: Server;
  let driver: PlaywrightWebDriver;
  let root: UINode;
  let rendered: string;

  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

    driver = new PlaywrightWebDriver(() => chromium.launch());
    await driver.launch({ entry: baseUrl, viewport: { width: 1280, height: 800 } });
    await driver.settle();
    root = (await driver.observe()).root;
    rendered = renderTree((await driver.observe({ interactiveOnly: true })).root);
  });

  after(async () => {
    await driver.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('une boîte vide qui ne rogne pas montre ses enfants', () => {
    it('display:contents : l\'emballage est visible, et son contenu rendu au modèle', async () => {
      assert.equal(byTestId(root, 'contents')?.state.visible, true);
      assert.match(rendered, /button "Dans un contents"/);
      // Le texte nu n'a pas de boîte à lui : c'est sa ligne qui le rend visible.
      assert.equal(byTestId(root, 'contents-texte')?.state.visible, true);
      assert.match(rendered, /text "Texte sans boîte"/);
    });

    it('un conteneur de flottants, de hauteur nulle, est visible avec son contenu', () => {
      const floats = byTestId(root, 'flottants');
      assert.equal(floats?.rect.height, 0, 'la page doit bien produire une boîte de hauteur nulle');
      assert.equal(floats?.state.visible, true);
      assert.match(rendered, /button "Flottant"/);
    });

    it('overflow-x:clip seul laisse déborder sur l\'axe vertical', () => {
      assert.equal(byTestId(root, 'deborde')?.state.visible, true);
      assert.ok(check(root, 'visible', { role: 'text', name: 'Déborde vers le bas' }));
    });

    /**
     * `resolve` décrit l'élément seul, sans parcourir ses enfants : il doit
     * pourtant le juger comme l'arbre complet. Le bouton n'a pas de boîte, son
     * texte en a une — Playwright le clique, et le refuser comme « non
     * visible » arrêtait le parcours sur une cible que l'utilisateur voit.
     */
    it('resolve trouve un bouton sans boîte dont le texte se voit, et le clic aboutit', async () => {
      const target = { primary: { role: 'button' as const, name: 'Bouton sans boîte' } };
      const outcome = await driver.resolve(target);
      assert.equal(outcome.found, true);
      assert.equal(outcome.found && outcome.node.state.visible, true);
      await driver.act({ kind: 'click', target });
    });
  });

  describe('un ancêtre qui rogne cache ses descendants', () => {
    it('accordéon replié : `visible` échoue et `absent` passe, comme l\'utilisateur le voit', () => {
      assert.equal(check(root, 'visible', { role: 'text', name: 'Détail replié' }), false);
      assert.equal(check(root, 'absent', { role: 'text', name: 'Détail replié' }), true);
      assert.equal(check(root, 'visible', { role: 'button', name: 'Action repliée' }), false);
      assert.doesNotMatch(rendered, /Détail replié|Action repliée/);
    });

    it('accordéon replié : resolve refuse d\'agir sur ce qui ne se voit pas', async () => {
      const outcome = await driver.resolve({ primary: { role: 'button', name: 'Action repliée' } });
      assert.deepEqual(outcome, { found: false, reason: 'not-visible', matches: 1 });
    });

    it('visibility:hidden cache ses descendants, sauf celui qui la remet à visible', async () => {
      assert.equal(check(root, 'absent', { role: 'text', name: 'Texte masqué' }), true);
      assert.equal(check(root, 'visible', { role: 'button', name: 'Action masquée' }), false);
      // Le navigateur peint ce descendant : le cacher serait un faux rouge.
      assert.equal(check(root, 'visible', { role: 'text', name: 'Texte remis' }), true);
      assert.equal(byTestId(root, 'masque')?.state.visible, true);
      assert.match(rendered, /text "Texte remis"/);
      assert.doesNotMatch(rendered, /Texte masqué|Action masquée/);
      const outcome = await driver.resolve({ primary: { role: 'button', name: 'Action masquée' } });
      assert.equal(outcome.found, false);
    });

    it('opacity:0 cache ses descendants, dont les enfants gardent une opacité de 1', async () => {
      assert.equal(check(root, 'absent', { role: 'text', name: 'Texte transparent' }), true);
      assert.equal(check(root, 'visible', { role: 'button', name: 'Action transparente' }), false);
      assert.doesNotMatch(rendered, /Texte transparent|Action transparente/);
      const outcome = await driver.resolve({ primary: { role: 'button', name: 'Action transparente' } });
      assert.deepEqual(outcome, { found: false, reason: 'not-visible', matches: 1 });
    });

    it('le contenu d\'un <details> fermé est caché, résumé excepté', () => {
      assert.ok(check(root, 'visible', { role: 'text', name: 'Plus de détails' }));
      assert.equal(check(root, 'absent', { role: 'text', name: 'Détail fermé' }), true);
      assert.doesNotMatch(rendered, /Détail fermé|Texte fermé/);
    });
  });

  describe('ce qui échappe au rognage reste visible', () => {
    it('un absolute dont le bloc conteneur est au-dessus du rogneur', () => {
      assert.ok(check(root, 'visible', { role: 'text', name: 'Échappe en absolu' }));
      assert.equal(check(root, 'absent', { role: 'text', name: 'Échappe en absolu' }), false);
    });

    it('mais pas un absolute dont le rogneur est le bloc conteneur', () => {
      assert.equal(check(root, 'visible', { role: 'text', name: 'Retenu en absolu' }), false);
    });

    it('un fixed sans ancêtre transformé', () => {
      assert.ok(check(root, 'visible', { role: 'text', name: 'Échappe en fixe' }));
    });

    /**
     * Les emballages entre le rogneur et l'échappé sont eux-mêmes rognés : les
     * juger invisibles sans regarder leurs enfants retirait l'échappé du rendu,
     * puisque le rendu écarte un nœud invisible avec ses descendants.
     */
    it('à travers des emballages rognés, et le rendu au modèle le garde', () => {
      assert.ok(check(root, 'visible', { role: 'text', name: 'Échappe de loin' }));
      // Sur l'arbre complet : l'aplatissement des emballages anonymes, en
      // `interactiveOnly`, masquerait le défaut.
      assert.match(renderTree(root), /text "Échappe de loin"/);
      assert.match(rendered, /text "Échappe de loin"/);
    });

    it('un dialogue modal, peint dans la top layer, échappe à l\'opacité de son ancêtre', async () => {
      assert.equal(byName(root, 'Dans la modale').length, 0, 'fermé, il n\'est pas rendu');

      await driver.act({ kind: 'click', target: { primary: { role: 'button', name: 'Ouvrir la modale' } } });
      try {
        const opened = (await driver.observe()).root;
        assert.ok(check(opened, 'visible', { role: 'text', name: 'Dans la modale' }));
        assert.match(renderTree(opened), /text "Dans la modale"/);
        const outcome = await driver.resolve({ primary: { role: 'button', name: 'Fermer' } });
        assert.equal(outcome.found, true);
      } finally {
        await driver.act({ kind: 'click', target: { primary: { role: 'button', name: 'Fermer' } } });
      }
    });
  });
});
