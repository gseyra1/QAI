import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { UINode } from '../types.ts';
import { fixture } from './fake-appium.ts';
import { readScreen } from './source.ts';

function flatten(node: UINode): UINode[] {
  return [node, ...node.children.flatMap(flatten)];
}

function named(root: UINode, role: UINode['role'], name: string): UINode {
  const found = flatten(root).filter((node) => node.role === role && node.name === name);
  assert.equal(found.length, 1, `exactly one ${role} "${name}" expected, found ${found.length}`);
  return found[0] as UINode;
}

const LOGIN = fixture('login.xml');

describe('XCUITest page source → UINode tree', () => {
  const { root, location, viewport, bundleId, elements } = readScreen(LOGIN, { mode: 'complete' });

  it('maps XCUIElementTypes to roles as documented in docs/driver.md', () => {
    assert.equal(named(root, 'button', 'Sign In').testId, 'login_button');
    assert.equal(named(root, 'link', 'Forgot password?').role, 'link');
    assert.equal(named(root, 'image', 'Acme logo').testId, 'logo');
    assert.equal(named(root, 'switch', 'Remember me').testId, 'remember_me');
    assert.equal(named(root, 'combobox', 'Delivery').value, 'Standard delivery');
    assert.equal(named(root, 'tablist', 'Tab Bar').children.length, 2);
    // Un bouton de barre d'onglets est un onglet, pas un bouton.
    assert.equal(named(root, 'tab', 'Settings').role, 'tab');
    assert.equal(root.role, 'group');
    assert.equal(root.name, 'Acme');
  });

  it('turns a StaticText carrying the Header trait into a heading', () => {
    assert.equal(named(root, 'heading', 'Welcome back').role, 'heading');
    // Le titre de la barre de navigation porte le trait, lui aussi.
    assert.equal(named(root, 'heading', 'Sign In').role, 'heading');
    assert.equal(named(root, 'text', 'Terms & Conditions').role, 'text');
  });

  it('names a field by its label, then its placeholder, never by its value', () => {
    const email = named(root, 'textbox', 'Email');
    assert.equal(email.testId, 'email_field');
    // WebDriverAgent rend l'indication comme valeur d'un champ vide.
    assert.equal(email.value, '');
  });

  it('never exposes the value of a secure text field', () => {
    const password = named(root, 'textbox', 'Password');
    assert.equal(password.value, undefined);
    assert.equal(JSON.stringify(root).includes('••'), false);
  });

  it('decodes entities in names', () => {
    assert.equal(named(root, 'text', 'Café — "open"').role, 'text');
  });

  it('reads state: enabled, visible, switch value, selected trait', () => {
    assert.equal(named(root, 'button', 'Create account').state.disabled, true);
    assert.equal(named(root, 'button', 'Sign In').state.disabled, undefined);
    assert.equal(named(root, 'switch', 'Remember me').state.checked, true);
    assert.equal(named(root, 'tab', 'Home').state.selected, true);
    assert.equal(named(root, 'tab', 'Settings').state.selected, undefined);
    // Sous le pli mais rendu : visible, comme sur le web ; sans boîte : non.
    assert.equal(named(root, 'button', 'Ghost').state.visible, true);
    assert.equal(named(root, 'button', 'Collapsed').state.visible, false);
  });

  it('keeps what XCUITest calls visible — on screen — apart, for scrolling only', () => {
    assert.equal(elements.get(named(root, 'button', 'Ghost').id)?.onScreen, false);
    assert.equal(elements.get(named(root, 'button', 'Sign In').id)?.onScreen, true);
  });

  it('reads the rect from x, y, width and height', () => {
    assert.deepEqual(named(root, 'button', 'Sign In').rect, { x: 16, y: 476, width: 358, height: 50 });
    assert.deepEqual(viewport, { x: 0, y: 0, width: 390, height: 844 });
  });

  it('sets testId only when the accessibility identifier differs from the label', () => {
    assert.equal(named(root, 'button', 'Create account').testId, undefined);
    assert.equal(named(root, 'link', 'Forgot password?').testId, undefined);
  });

  it('leaves the keyboard out of the tree', () => {
    const names = flatten(root).map((node) => node.name);
    assert.equal(names.includes('q'), false);
    assert.equal(names.includes('return'), false);
  });

  it('locates the screen by bundle id and navigation bar title', () => {
    assert.equal(bundleId, 'com.example.acme');
    assert.equal(location, 'com.example.acme/Sign In');
  });

  it('records a positional XPath for each node, counted on the raw source, closed by its identity', () => {
    const button = named(root, 'button', 'Sign In');
    assert.deepEqual(elements.get(button.id), {
      type: 'XCUIElementTypeButton',
      xpath:
        '//XCUIElementTypeApplication[1]/XCUIElementTypeWindow[1]/XCUIElementTypeOther[1]' +
        '/XCUIElementTypeOther[1]/XCUIElementTypeOther[1]/XCUIElementTypeButton[1][@name="login_button"]',
      onScreen: true,
    });
    const settings = named(root, 'tab', 'Settings');
    assert.equal(
      elements.get(settings.id)?.xpath,
      '//XCUIElementTypeApplication[1]/XCUIElementTypeWindow[1]/XCUIElementTypeOther[1]' +
        '/XCUIElementTypeTabBar[1]/XCUIElementTypeButton[2][@name="Settings"]',
    );
    // Sans `name`, le libellé ; sans rien, le rang seul.
    const wrapper = elements.get(named(root, 'tablist', 'Tab Bar').id);
    assert.match(wrapper?.xpath ?? '', /XCUIElementTypeTabBar\[1\]\[@name="Tab Bar"\]$/);
  });

  it('quotes an identity that carries quotes, with concat() when it carries both', () => {
    const xml =
      '<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="A" label="A" x="0" y="0" width="100" height="100">' +
      '<XCUIElementTypeButton type="XCUIElementTypeButton" name="Say &quot;hi&quot;" label="x" x="0" y="0" width="10" height="10"/>' +
      '<XCUIElementTypeButton type="XCUIElementTypeButton" name="It&apos;s &quot;on&quot;" label="y" x="0" y="20" width="10" height="10"/>' +
      '</XCUIElementTypeApplication></AppiumAUT>';
    const screen = readScreen(xml, { mode: 'complete' });
    const paths = flatten(screen.root).slice(1).map((node) => screen.elements.get(node.id)?.xpath);
    assert.deepEqual(paths, [
      `//XCUIElementTypeApplication[1]/XCUIElementTypeButton[1][@name='Say "hi"']`,
      `//XCUIElementTypeApplication[1]/XCUIElementTypeButton[2][@name=concat("It's ", '"', "on", '"', "")]`,
    ]);
  });

  it('drops leaves without a box when observing, like hidden nodes on the web', () => {
    const observed = readScreen(LOGIN, { mode: 'observe' }).root;
    assert.equal(flatten(observed).some((node) => node.name === 'Collapsed'), false);
    assert.equal(flatten(observed).some((node) => node.name === 'Ghost'), true);
    assert.equal(flatten(observed).some((node) => node.name === 'Sign In' && node.role === 'button'), true);
  });

  it('prunes and flattens anonymous wrappers with interactiveOnly', () => {
    const full = flatten(readScreen(LOGIN, { mode: 'observe' }).root);
    const pruned = flatten(readScreen(LOGIN, { mode: 'observe', interactiveOnly: true }).root);
    assert.ok(pruned.length < full.length, `${pruned.length} < ${full.length}`);
    // Aucun emballage anonyme à enfant unique ne survit, hors racine.
    const wrappers = pruned.slice(1).filter((node) => node.role === 'group' && node.name === '' && node.children.length === 1);
    assert.deepEqual(wrappers, []);
    for (const name of ['Sign In', 'Email', 'Password', 'Remember me', 'Delivery', 'Settings']) {
      assert.ok(pruned.some((node) => node.name === name), name);
    }
  });

  it('maps tables to lists and cells to list items', () => {
    const orders = readScreen(fixture('orders.xml'), { mode: 'complete' });
    const table = flatten(orders.root).find((node) => node.role === 'list');
    assert.equal(table?.testId, 'orders_table');
    assert.deepEqual(
      table?.children.map((cell) => [cell.role, cell.testId]),
      [['listitem', 'order_1040'], ['listitem', 'order_1041'], ['listitem', 'order_1042']],
    );
    assert.equal(orders.location, 'com.example.acme/Orders');
  });

  it('maps an alert and an action sheet to dialogs, and records them as open', () => {
    for (const [file, name, button] of [
      ['alert.xml', 'Delete account?', 'Delete'],
      ['sheet.xml', 'Order actions', 'Share'],
    ] as const) {
      const screen = readScreen(fixture(file), { mode: 'complete' });
      const dialog = named(screen.root, 'dialog', name);
      const inside = flatten(dialog).find((node) => node.role === 'button' && node.name === button);
      assert.ok(inside !== undefined, file);
      assert.deepEqual(screen.modals, [{ id: dialog.id, name }]);
      assert.equal(screen.elements.get(inside.id)?.modal, dialog.id);
    }
    assert.deepEqual(readScreen(LOGIN, { mode: 'complete' }).modals, []);
  });

  it('reads on-screen from geometry when the visible attribute is excluded from the source', () => {
    const xml =
      '<AppiumAUT><XCUIElementTypeApplication type="XCUIElementTypeApplication" name="A" label="A" x="0" y="0" width="100" height="100">' +
      '<XCUIElementTypeButton type="XCUIElementTypeButton" name="Shown" label="Shown" x="0" y="0" width="10" height="10"/>' +
      '<XCUIElementTypeButton type="XCUIElementTypeButton" name="Flat" label="Flat" x="0" y="0" width="0" height="0"/>' +
      '</XCUIElementTypeApplication></AppiumAUT>';
    const screen = readScreen(xml, { mode: 'complete', bundleId: 'com.example.known' });
    assert.equal(named(screen.root, 'button', 'Shown').state.visible, true);
    assert.equal(named(screen.root, 'button', 'Flat').state.visible, false);
    assert.equal(screen.elements.get(named(screen.root, 'button', 'Shown').id)?.onScreen, true);
    // Sans attribut bundleId dans la source, le bundle connu du pilote sert.
    assert.equal(screen.location, 'com.example.known');
  });
});
