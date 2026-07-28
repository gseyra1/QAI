import type { Locator as PWLocator, Page } from 'playwright';
import type { Locator, PlatformFallback, Role } from '../types.ts';

type Scope = Pick<Page, 'getByRole' | 'getByText' | 'getByTestId' | 'locator'>;

/**
 * Projection du vocabulaire QAI vers les rôles ARIA de Playwright.
 *
 * `text` est absent volontairement : ce n'est pas un rôle ARIA et il se cible
 * par le contenu. `unknown` est absent aussi — on ne filtre alors pas par rôle.
 */
const ARIA: Partial<Record<Role, string>> = {
  button: 'button',
  link: 'link',
  heading: 'heading',
  image: 'img',
  textbox: 'textbox',
  searchbox: 'searchbox',
  combobox: 'combobox',
  checkbox: 'checkbox',
  radio: 'radio',
  switch: 'switch',
  slider: 'slider',
  list: 'list',
  listitem: 'listitem',
  table: 'table',
  row: 'row',
  cell: 'cell',
  tab: 'tab',
  tablist: 'tablist',
  dialog: 'dialog',
  menu: 'menu',
  menuitem: 'menuitem',
  progressbar: 'progressbar',
  alert: 'alert',
  group: 'group',
};

function nameOptions(name: Locator['name']): { name: string; exact: boolean } | undefined {
  if (name === undefined) return undefined;
  if (typeof name === 'string') return { name, exact: true };
  return { name: name.contains, exact: false };
}

/**
 * Construit un locator Playwright à partir d'un locator QAI.
 *
 * `applyNth` est laissé à false par l'étape de résolution : il faut compter les
 * correspondances *avant* de désambiguïser, sinon un locator devenu ambigu
 * (deux boutons « Valider » là où il n'y en avait qu'un) passerait pour valide
 * en pointant silencieusement le mauvais élément.
 */
export function buildLocator(page: Page, loc: Locator, applyNth = true): PWLocator {
  const scope: Scope = loc.within ? buildLocator(page, loc.within) : page;
  const nameOpts = nameOptions(loc.name);
  const aria = loc.role !== undefined ? ARIA[loc.role] : undefined;

  let built: PWLocator;
  if (aria !== undefined) {
    built = nameOpts
      ? scope.getByRole(aria as Parameters<Scope['getByRole']>[0], nameOpts)
      : scope.getByRole(aria as Parameters<Scope['getByRole']>[0]);
  } else if (nameOpts) {
    built = scope.getByText(nameOpts.name, { exact: nameOpts.exact });
  } else {
    built = scope.locator('body');
  }

  if (applyNth && loc.nth !== undefined) built = built.nth(loc.nth);
  return built;
}

/**
 * Le repli ne sert que si `primary` n'a rien trouvé. `accessibilityId` n'a pas
 * d'équivalent web et est ignoré ici — il existe pour les drivers mobiles.
 */
export function buildFallback(page: Page, fallback: PlatformFallback): PWLocator | null {
  if (fallback.testId !== undefined) return page.getByTestId(fallback.testId);
  if (fallback.selector !== undefined) return page.locator(fallback.selector);
  return null;
}
