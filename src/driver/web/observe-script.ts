import type { Role, UINode } from '../types.ts';

/**
 * Le corps de `observe()` côté web, destiné à être sérialisé et exécuté dans la
 * page. Il ne peut donc rien capturer de sa portée extérieure : tout ce dont il
 * a besoin passe par son argument.
 *
 * Il est isolé dans son propre module pour rester testable hors navigateur —
 * voir observe-script.test.ts, qui l'exécute sur un DOM factice.
 */
export function collectTree(
  root: Element,
  options: { interactiveOnly: boolean; maxDepth?: number },
): UINode {
  const INTERACTIVE: ReadonlySet<Role> = new Set<Role>([
    'button',
    'link',
    'textbox',
    'searchbox',
    'combobox',
    'checkbox',
    'radio',
    'switch',
    'slider',
    'tab',
    'menuitem',
  ]);

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE']);

  /** Rôles dont accname autorise le nom déduit du contenu textuel. */
  const NAME_FROM_CONTENT: ReadonlySet<Role> = new Set<Role>([
    'button',
    'link',
    'heading',
    'text',
    'cell',
    'listitem',
    'menuitem',
    'tab',
    'checkbox',
    'radio',
    'switch',
    'alert',
  ]);

  let counter = 0;

  function inputRole(el: HTMLInputElement): Role {
    switch (el.type) {
      case 'button':
      case 'submit':
      case 'reset':
      case 'image':
        return 'button';
      case 'search':
        return 'searchbox';
      case 'checkbox':
        return 'checkbox';
      case 'radio':
        return 'radio';
      case 'range':
        return 'slider';
      case 'hidden':
        return 'unknown';
      default:
        return 'textbox';
    }
  }

  function implicitRole(el: Element): Role {
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : 'group';
    if (tag === 'BUTTON') return 'button';
    if (tag === 'INPUT') return inputRole(el as HTMLInputElement);
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'IMG') return 'image';
    if (tag === 'UL' || tag === 'OL') return 'list';
    if (tag === 'LI') return 'listitem';
    if (tag === 'TABLE') return 'table';
    if (tag === 'TR') return 'row';
    if (tag === 'TD' || tag === 'TH') return 'cell';
    if (tag === 'DIALOG') return 'dialog';
    if (tag === 'PROGRESS') return 'progressbar';
    if (tag === 'NAV' || tag === 'MENU') return 'menu';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'P' || tag === 'SPAN' || tag === 'LABEL' || tag === 'STRONG' || tag === 'EM') {
      return 'text';
    }
    return 'group';
  }

  const EXPLICIT: ReadonlySet<string> = new Set<Role>([
    'button', 'link', 'text', 'heading', 'image', 'textbox', 'searchbox', 'combobox',
    'checkbox', 'radio', 'switch', 'slider', 'list', 'listitem', 'table', 'row',
    'cell', 'tab', 'tablist', 'dialog', 'menu', 'menuitem', 'progressbar', 'alert',
    'group',
  ]);

  function roleOf(el: Element): Role {
    const declared = el.getAttribute('role');
    if (declared) {
      const first = declared.trim().split(/\s+/)[0];
      if (first !== undefined && EXPLICIT.has(first)) return first as Role;
      if (first === 'gridcell') return 'cell';
      if (first === 'option') return 'listitem';
    }
    return implicitRole(el);
  }

  function collapse(s: string): string {
    return s.replace(/\s+/g, ' ').trim();
  }

  function ownText(el: Element): string {
    return collapse(el.textContent ?? '');
  }

  /**
   * Approximation pragmatique de la spécification accname : elle couvre les cas
   * qui comptent en pratique sans réimplémenter l'algorithme complet. Playwright
   * applique la vraie spécification côté résolution, donc un écart ici ne peut
   * produire qu'un candidat manqué à l'observation, jamais une action erronée.
   */
  function accessibleName(el: Element): string {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const parts = labelledBy
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id))
        .filter((n): n is HTMLElement => n !== null)
        .map((n) => ownText(n));
      if (parts.length > 0) return collapse(parts.join(' '));
    }

    const label = el.getAttribute('aria-label');
    if (label) return collapse(label);

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      if (el.labels && el.labels.length > 0) {
        const text = Array.from(el.labels).map((l) => ownText(l)).join(' ');
        if (text) return collapse(text);
      }
      if (el instanceof HTMLInputElement && (el.type === 'button' || el.type === 'submit' || el.type === 'reset')) {
        if (el.value) return collapse(el.value);
      }
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return collapse(placeholder);
    }

    if (el instanceof HTMLImageElement) {
      const alt = el.getAttribute('alt');
      if (alt !== null) return collapse(alt);
    }

    const title = el.getAttribute('title');
    if (title) return collapse(title);

    // Le nom déduit du contenu ne vaut que pour les rôles qu'accname désigne.
    // Un conteneur générique n'a pas de nom : lui attribuer le texte de ses
    // descendants dupliquait ce texte à chaque niveau d'emballage — arbre
    // gonflé, et un `div` capable de satisfaire par erreur une assertion
    // portant sur son contenu.
    if (!NAME_FROM_CONTENT.has(roleOf(el))) return '';

    const text = ownText(el);
    return text.length <= 120 ? text : '';
  }

  function valueOf(el: Element): string | undefined {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') return undefined;
      return el.value;
    }
    if (el instanceof HTMLTextAreaElement) return el.value;
    if (el instanceof HTMLSelectElement) return el.value;
    const now = el.getAttribute('aria-valuenow');
    return now ?? undefined;
  }

  function isVisible(el: Element, rect: DOMRect): boolean {
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = el.ownerDocument.defaultView?.getComputedStyle(el);
    if (!style) return true;
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (Number.parseFloat(style.opacity) === 0) return false;
    return true;
  }

  function ariaFlag(el: Element, attr: string): boolean | undefined {
    const raw = el.getAttribute(attr);
    if (raw === null) return undefined;
    return raw === 'true';
  }

  function stateOf(el: Element, visible: boolean): UINode['state'] {
    const state: UINode['state'] = { visible };

    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') state.checked = el.checked;
      if (el.disabled) state.disabled = true;
    } else if (
      el instanceof HTMLButtonElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLTextAreaElement
    ) {
      if (el.disabled) state.disabled = true;
    }

    const checked = ariaFlag(el, 'aria-checked');
    if (checked !== undefined) state.checked = checked;
    const disabled = ariaFlag(el, 'aria-disabled');
    if (disabled !== undefined) state.disabled = disabled;
    const expanded = ariaFlag(el, 'aria-expanded');
    if (expanded !== undefined) state.expanded = expanded;
    const selected = ariaFlag(el, 'aria-selected');
    if (selected !== undefined) state.selected = selected;

    if (el.ownerDocument.activeElement === el) state.focused = true;

    return state;
  }

  function keep(node: UINode): boolean {
    if (!options.interactiveOnly) return true;
    if (INTERACTIVE.has(node.role)) return true;
    if (node.children.length > 0) return true;
    return node.name.length > 0 && node.role !== 'group';
  }

  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;

  function walk(el: Element, isRoot: boolean, depth: number): UINode | null {
    if (!isRoot && SKIP.has(el.tagName)) return null;
    if (!isRoot && el.getAttribute('aria-hidden') === 'true') return null;

    const rect = el.getBoundingClientRect();
    const visible = isVisible(el, rect);

    const children: UINode[] = [];
    if (depth < maxDepth) {
      for (const child of Array.from(el.children)) {
        const built = walk(child, false, depth + 1);
        if (built !== null) children.push(built);
      }
    }

    const node: UINode = {
      id: `n${counter++}`,
      role: roleOf(el),
      name: accessibleName(el),
      state: stateOf(el, visible),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      children,
    };

    const value = valueOf(el);
    if (value !== undefined) node.value = value;

    if (isRoot) return node;
    if (!visible && children.length === 0) return null;

    // Aplatir les emballages anonymes. Un conteneur non interactif, sans nom
    // accessible et n'ayant qu'un seul enfant survivant, ne dit rien au modèle
    // et double le poids de l'arbre sur une application à composants — ce qui
    // se paie directement en jetons à chaque réparation.
    const only = children[0];
    if (
      options.interactiveOnly &&
      only !== undefined &&
      children.length === 1 &&
      node.name === '' &&
      !INTERACTIVE.has(node.role)
    ) {
      return only;
    }

    return keep(node) ? node : null;
  }

  return walk(root, true, 0) as UINode;
}
