import type { Role, UINode } from '../types.ts';

/**
 * Le corps de `observe()` côté web, destiné à être sérialisé et exécuté dans la
 * page. Il ne peut donc rien capturer de sa portée extérieure : tout ce dont il
 * a besoin passe par son argument.
 *
 * Il est isolé dans son propre module pour être sérialisé tel quel. Ses
 * règles de visibilité se vérifient sur Chromium — voir visibility.test.ts :
 * ce sont les boîtes du navigateur qui les départagent.
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
      // `aria-hidden` et `visibility:hidden` sont exclus SANS espace : le
      // navigateur colle les textes voisins (« SaveDraft »).
      if (element.getAttribute('aria-hidden') === 'true') continue;

      /**
       * `<br>` est un saut de ligne : accname le compte comme une espace, et
       * le navigateur aussi. L'ignorer collait « ligne1ligne2 » là où la
       * vérification lit « ligne1 ligne2 ».
       */
      if (element.tagName === 'BR') {
        out += ' ';
        continue;
      }

      const style = element.ownerDocument.defaultView?.getComputedStyle(element);

      /**
       * `display:none` retire l'élément du flux : le navigateur traite le trou
       * comme une espace (« Save<span style=display:none>x</span>Draft » →
       * « Save Draft »), alors que `visibility:hidden` colle les voisins
       * (« SaveDraft »). Reproduire exactement ces deux comportements est ce
       * qui rend le nom observé résoluble par `getByRole` — un espace en trop
       * ou en moins, et la cible devient introuvable. Les bords sont ensuite
       * rognés par `collapse`.
       */
      if (style?.display === 'none') {
        out += ' ';
        continue;
      }
      if (style?.visibility === 'hidden') continue;

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

    const content = contentName(el);
    if (content !== '') return content;

    // Dernier recours de la spécification : `title`. Une icône sans texte —
    // `<i title="Fermer"></i>` — apporte « Fermer » au nom de son bouton, que
    // le navigateur calcule (« FermerLabel ») et que la vérification cherchera.
    // L'ignorer produisait « Label », un nom que `getByRole` ne trouve jamais.
    return el.getAttribute('title') ?? '';
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

  /**
   * Ce que les ancêtres imposent à un élément, indépendamment de sa propre boîte.
   *
   * Une boîte vide ne dit rien à elle seule : un `display:contents` ou un
   * conteneur de flottants mesure 0 et montre pourtant ses enfants, alors
   * qu'un accordéon replié (`height:0; overflow:hidden`) mesure 0 et les
   * cache. Les enfants, eux, gardent leur boîte dans les deux cas. Seul ce
   * contexte, transmis du haut vers le bas, sépare les deux.
   *
   * - `hidden` : rien n'est peint, et rien n'y échappe sauf la top layer.
   *   `display:none`, `opacity:0`, `content-visibility:hidden`, le contenu
   *   d'un `<details>` fermé.
   * - `clipped` : une boîte vide qui rogne. En échappe ce dont le bloc
   *   conteneur est au-dessus du rogneur — un `absolute` sans ancêtre
   *   positionné depuis le rogneur, un `fixed` sans ancêtre transformé —
   *   exactement comme le navigateur le peint.
   * - `absContained` / `fixedContained` : depuis le rogneur le plus haut, un
   *   ancêtre fournit le bloc conteneur d'un `absolute` / d'un `fixed`.
   *
   * `visibility:hidden` n'y figure pas : la propriété s'hérite déjà par le
   * style calculé, et un descendant qui la remet à `visible` est réellement
   * peint.
   */
  interface Scope {
    hidden: boolean;
    clipped: boolean;
    absContained: boolean;
    fixedContained: boolean;
  }

  const OPEN: Scope = { hidden: false, clipped: false, absContained: false, fixedContained: false };

  function styleOf(el: Element): CSSStyleDeclaration | null {
    return el.ownerDocument.defaultView?.getComputedStyle(el) ?? null;
  }

  function matches(el: Element, selector: string): boolean {
    try {
      return el.matches(selector);
    } catch {
      // Pseudo-classe inconnue du moteur : l'élément ne peut pas en relever.
      return false;
    }
  }

  // Lu une fois : l'accesseur n'est pas gratuit, et l'arbre passe par
  // `inTopLayer` pour chaque élément.
  const fullscreen = root.ownerDocument.fullscreenElement;

  /**
   * Un dialogue modal, un popover ouvert, un plein écran : peints au-dessus
   * de tout, hors de l'arbre de leurs ancêtres. Ni leur rognage ni leur
   * opacité ne s'y appliquent.
   */
  function inTopLayer(el: Element): boolean {
    if (el === fullscreen) return true;
    if (el.tagName === 'DIALOG' && matches(el, ':modal')) return true;
    return el.hasAttribute('popover') && matches(el, ':popover-open');
  }

  const PAINT_CONTAINMENT = /\b(paint|strict|content)\b/;

  /** Une valeur calculée au défaut : absente du moteur, vide, ou son mot-clé initial. */
  function initial(value: string | undefined): boolean {
    return value === undefined || value === '' || value === 'none' || value === 'normal' || value === 'auto';
  }

  /** Le bloc conteneur d'un descendant `fixed` : un ancêtre transformé, filtré ou contenu. */
  function holdsFixed(style: CSSStyleDeclaration): boolean {
    if (!initial(style.transform) || !initial(style.perspective) || !initial(style.filter)) return true;
    if (!initial(style.translate) || !initial(style.rotate) || !initial(style.scale)) return true;
    if (!initial(style.backdropFilter) || !initial(style.containerType)) return true;
    if (/\b(layout|paint|strict|content)\b/.test(style.contain ?? '')) return true;
    return /\b(transform|perspective|filter|translate|rotate|scale)\b/.test(style.willChange ?? '');
  }

  /** `overflow` ne s'applique qu'aux conteneurs de blocs, de flex, de grille. */
  function canClip(display: string): boolean {
    if (display === 'inline' || display === 'contents' || display === 'none') return false;
    if (display.startsWith('table-')) return display === 'table-cell' || display === 'table-caption';
    return true;
  }

  /**
   * Une boîte de taille nulle qui rogne, sur l'axe où elle est nulle.
   *
   * `overflow-x:clip` avec `overflow-y:visible` laisse déborder vers le bas :
   * un `height:0` ainsi réglé montre son contenu. La racine ne rogne jamais
   * — son `overflow` est celui de la fenêtre —, et `body` non plus tant que
   * la racine laisse le sien à `visible` : il est alors reporté sur la
   * fenêtre. C'est le motif « modale ouverte » (`body { overflow:hidden }`),
   * où `body` mesure souvent 0 parce que l'application est en `fixed`.
   */
  function clipsEmpty(el: Element, style: CSSStyleDeclaration, rect: DOMRect): boolean {
    if (rect.width > 0 && rect.height > 0) return false;
    if (!canClip(style.display)) return false;
    const doc = el.ownerDocument;
    if (el === doc.documentElement) return false;
    if (el === doc.body && doc.documentElement !== null) {
      const root = styleOf(doc.documentElement);
      if (root === null || (root.overflowX === 'visible' && root.overflowY === 'visible')) return false;
    }
    const contained = PAINT_CONTAINMENT.test(style.contain ?? '');
    const clipsX = contained || style.overflowX !== 'visible';
    const clipsY = contained || style.overflowY !== 'visible';
    return (rect.width <= 0 && clipsX) || (rect.height <= 0 && clipsY);
  }

  /** Le contexte qui s'applique à l'élément lui-même, une fois ses échappées comptées. */
  function scopeOf(el: Element, style: CSSStyleDeclaration | null, inherited: Scope): Scope {
    if (inTopLayer(el)) return OPEN;
    if (!inherited.clipped || inherited.hidden || style === null) return inherited;
    if (style.position === 'fixed' && !inherited.fixedContained) return { ...inherited, clipped: false };
    if (style.position === 'absolute' && !inherited.absContained) return { ...inherited, clipped: false };
    return inherited;
  }

  /** Le contexte que l'élément transmet à ses enfants. */
  function scopeBelow(el: Element, style: CSSStyleDeclaration | null, rect: DOMRect, own: Scope): Scope {
    if (style === null || own.hidden) return own;
    const hides =
      style.display === 'none' ||
      Number.parseFloat(style.opacity) === 0 ||
      style.contentVisibility === 'hidden';
    if (hides) return { ...own, hidden: true };
    if (own.clipped) {
      if (own.fixedContained) return own;
      const fixed = holdsFixed(style);
      const abs = own.absContained || fixed || style.position !== 'static';
      return abs === own.absContained && fixed === own.fixedContained
        ? own
        : { ...own, absContained: abs, fixedContained: fixed };
    }
    if (!clipsEmpty(el, style, rect)) return own;
    // Le bloc conteneur d'un `absolute` : tout ancêtre positionné, ou qui tient un `fixed`.
    const fixed = holdsFixed(style);
    return { ...own, clipped: true, absContained: fixed || style.position !== 'static', fixedContained: fixed };
  }

  /**
   * Le contexte de chacun des enfants. Un `<details>` fermé ne peint que son
   * premier `<summary>` : le reste est caché.
   */
  function childScopes(parent: Element, below: Scope): (child: Element) => Scope {
    if (below.hidden || parent.tagName !== 'DETAILS' || parent.hasAttribute('open')) return () => below;
    const summary = Array.from(parent.children).find((one) => one.tagName === 'SUMMARY');
    const hidden = { ...below, hidden: true };
    return (child) => (child === summary ? below : hidden);
  }

  /** L'élément peint-il sa propre boîte ? Ses enfants sont jugés à part. */
  function paintsItself(style: CSSStyleDeclaration | null, rect: DOMRect): boolean {
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (style === null) return true;
    if (style.display === 'none' || style.display === 'contents') return false;
    if (style.visibility !== 'visible') return false;
    return Number.parseFloat(style.opacity) !== 0;
  }

  /** Un texte nu, posé directement dans un élément sans boîte : `display:contents`. */
  function paintsText(el: Element, style: CSSStyleDeclaration | null, below: Scope): boolean {
    if (below.hidden || below.clipped) return false;
    if (style !== null && style.visibility !== 'visible') return false;
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType !== 3 || (child.textContent ?? '').trim() === '') continue;
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(child);
      if (Array.from(range.getClientRects()).some((box) => box.width > 0 && box.height > 0)) return true;
    }
    return false;
  }

  interface Judged {
    style: CSSStyleDeclaration | null;
    rect: DOMRect;
    /** Le contexte de l'élément lui-même. */
    scope: Scope;
    /** Celui de ses enfants. */
    below: Scope;
  }

  function judge(el: Element, inherited: Scope): Judged {
    const style = styleOf(el);
    const rect = el.getBoundingClientRect();
    const scope = scopeOf(el, style, inherited);
    // Sans enfant ni texte, rien n'hérite de son contexte.
    const below = el.firstChild === null ? scope : scopeBelow(el, style, rect, scope);
    return { style, rect, scope, below };
  }

  /**
   * Visible : peint par lui-même, ou par l'un de ses descendants.
   *
   * La seconde moitié est ce qui rend un emballage sans boîte visible quand
   * son contenu l'est — et garantit l'invariant dont dépend le rendu pour le
   * modèle : un nœud invisible n'a aucun descendant visible. `children`
   * n'est consulté que si l'élément ne se peint pas lui-même — y compris
   * quand un ancêtre le cache : un descendant peut encore s'en échapper
   * (`absolute`, `fixed`, top layer), et l'emballage qui le porte doit rester
   * visible pour que le rendu le garde.
   */
  function shown(el: Element, judged: Judged, children: () => boolean): boolean {
    const { style, rect, scope, below } = judged;
    if (style !== null && style.display === 'none') return false;
    if (!scope.hidden && !scope.clipped && paintsItself(style, rect)) return true;
    return children() || paintsText(el, style, below);
  }

  /** La même décision, sans construire de nœud : pour ce que l'arbre ne parcourt pas. */
  function shownDeep(el: Element, inherited: Scope): boolean {
    const judged = judge(el, inherited);
    const scopeOfChild = childScopes(el, judged.below);
    return shown(el, judged, () => Array.from(el.children).some((child) => shownDeep(child, scopeOfChild(child))));
  }

  /**
   * Le contexte hérité d'une racine qui n'est pas le document : `resolve`
   * décrit un élément seul, et doit le juger comme l'arbre complet le jugerait.
   */
  function scopeAbove(el: Element): Scope {
    const chain: Element[] = [];
    for (let up = el.parentElement; up !== null; up = up.parentElement) chain.unshift(up);
    let scope = OPEN;
    chain.forEach((ancestor, index) => {
      scope = childScopes(ancestor, judge(ancestor, scope).below)(chain[index + 1] ?? el);
    });
    return scope;
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

  /** Le nœud construit, et si l'élément est visible — même quand le nœud est écarté. */
  interface Walked {
    node: UINode | null;
    /** `null` : non jugé, l'arbre ne l'a pas parcouru. */
    visible: boolean | null;
  }

  function walk(el: Element, isRoot: boolean, depth: number, inherited: Scope): Walked {
    // Les balises écartées ne sont jamais rendues ; `aria-hidden` l'est
    // peut-être, et n'est jugé qu'à la demande d'un parent sans boîte.
    if (!isRoot && SKIP.has(el.tagName)) return { node: null, visible: false };
    if (!isRoot && el.getAttribute('aria-hidden') === 'true') return { node: null, visible: null };

    const judged = judge(el, inherited);
    const rect = judged.rect;

    const scopeOfChild = childScopes(el, judged.below);
    const children: UINode[] = [];
    const verdicts: { child: Element; visible: boolean | null }[] = [];
    for (const child of Array.from(el.children)) {
      if (depth >= maxDepth) {
        verdicts.push({ child, visible: null });
        continue;
      }
      const built = walk(child, false, depth + 1, scopeOfChild(child));
      verdicts.push({ child, visible: built.visible });
      if (built.node !== null) children.push(built.node);
    }

    const visible = shown(el, judged, () =>
      verdicts.some(({ child, visible: known }) => known ?? shownDeep(child, scopeOfChild(child))),
    );

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

    if (isRoot) return { node, visible };
    if (!visible && children.length === 0) return { node: null, visible };

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
      return { node: only, visible };
    }

    return { node: keep(node) ? node : null, visible };
  }

  return walk(root, true, 0, scopeAbove(root)).node as UINode;
}
