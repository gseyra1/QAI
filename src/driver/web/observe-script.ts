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

    /**
     * Un conteneur générique qui ne contient QUE du texte est une feuille de
     * texte, pas un groupe.
     *
     * Sans cette règle, tout texte écrit dans un `div` est invisible :
     * `group` n'est pas un rôle dont accname déduit le nom, donc le nœud sort
     * de l'observation avec un nom vide et le texte disparaît de l'arbre. Or
     * c'est le rendu par défaut d'à peu près toutes les bibliothèques de
     * composants — antd y met ses messages de validation de formulaire, ce
     * qui rend « le formulaire refuse une saisie vide » inexprimable.
     *
     * La règle est délibérément étroite : uniquement une feuille (aucun enfant
     * élément), et uniquement sans nom déclaré. Un `div` portant `aria-label`
     * ou un `role` explicite garde son rôle, donc aucun ciblage existant ne
     * change de sens.
     */
    if (
      el.children.length === 0 &&
      !el.hasAttribute('aria-label') &&
      !el.hasAttribute('aria-labelledby') &&
      (el.textContent ?? '').trim() !== ''
    ) {
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
   * Nom déduit du contenu, en suivant accname plutôt que le texte brut.
   *
   * `textContent` ne voit que les nœuds de texte. Or un descendant peut porter
   * son nom ailleurs — une icône est typiquement
   * `<span role="img" aria-label="team">` sans le moindre texte. La
   * spécification, elle, fait contribuer à chaque descendant son propre nom
   * accessible : le navigateur lit donc « team Élèves » là où `textContent` ne
   * rend que « Élèves ».
   *
   * L'écart n'est pas bénin. C'est cet arbre qu'on montre au modèle à la
   * génération, tandis que la VÉRIFICATION passe par le calcul du navigateur :
   * les deux doivent nommer les éléments de la même façon. Sinon le modèle
   * recopie fidèlement un nom que la vérification rejettera toujours, et
   * `resolve` ne peut converger sur aucune cible porteuse d'icône.
   */
  function contentName(el: Element): string {
    let out = '';

    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === 3) {
        out += child.textContent ?? '';
        continue;
      }
      if (child.nodeType !== 1) continue;

      const element = child as Element;
      // accname exclut les sous-arbres masqués aux technologies d'assistance.
      if (element.getAttribute('aria-hidden') === 'true') continue;

      const part = contributionOf(element);
      if (part === '') continue;

      /**
       * Le séparateur dépend du rendu, il n'est pas systématique.
       *
       * accname n'insère un espace qu'autour d'un descendant qui n'est pas en
       * ligne — c'est ce que fait le navigateur, donc ce que voit la
       * vérification. Joindre inconditionnellement produirait « Envo yer »
       * pour `<button>Envo<b>yer</b></button>` : un nom que Playwright ne
       * calculera jamais, donc une cible que `resolve` ne pourra pas viser.
       */
      const style = element.ownerDocument.defaultView?.getComputedStyle(element);
      out += style?.display === 'inline' ? part : ` ${part} `;
    }

    return collapse(out);
  }

  /** Ce qu'un descendant apporte au nom de son parent, selon accname. */
  function contributionOf(el: Element): string {
    const label = el.getAttribute('aria-label');
    if (label) return label;

    if (el instanceof HTMLImageElement) {
      // `alt=""` est une image décorative : elle n'apporte rien, et ce n'est
      // pas la même chose qu'une image sans `alt` du tout.
      const alt = el.getAttribute('alt');
      if (alt !== null) return alt;
    }

    return contentName(el);
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

    const text = contentName(el);
    return text.length <= 120 ? text : '';
  }

  function valueOf(el: Element): string | undefined {
    if (el instanceof HTMLInputElement) {
      if (el.type === 'checkbox' || el.type === 'radio') return undefined;
      // Jamais la valeur d'un mot de passe : le snapshot part vers le modèle
      // branché par le client, un secret saisi ne doit pas quitter la page.
      if (el.type === 'password') return undefined;
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

    const testId = el.getAttribute('data-testid');
    if (testId !== null && testId !== '') node.testId = testId;

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
      // L'identifiant de test d'un emballage aplati descend sur son unique
      // enfant : c'est le même élément aux yeux de l'auteur de la page.
      if (node.testId !== undefined && only.testId === undefined) only.testId = node.testId;
      return only;
    }

    return keep(node) ? node : null;
  }

  return walk(root, true, 0) as UINode;
}
