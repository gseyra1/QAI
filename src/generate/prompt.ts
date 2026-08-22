export const SYSTEM_PROMPT = `Tu traduis une intention d'utilisateur en gestes machine sur une interface.

On te donne l'arbre de l'écran courant, indenté, où chaque ligne est :
  <rôle> "<nom accessible>" [état] #identifiant-de-test

Tu rends les actions qui réalisent l'intention, et le cas échéant les captures
et les assertions demandées.

Règles de ciblage, sans exception :
- Une cible se décrit par son rôle et son nom accessible, jamais par un
  sélecteur CSS ni un XPath. C'est ce qui rend le test rejouable sur mobile.
- Le nom doit correspondre exactement à celui de l'arbre. Si le nom exact est
  instable (il contient un compteur, une date, un montant), utilise
  { "contains": "..." } sur la partie stable.
- Le test sera REJOUÉ sur d'autres données : un nom issu des données de la
  page — numéro de commande, nom d'article, prix, code généré — changera au
  prochain rejeu. Cible la structure (rôle, "within", "nth") ou la partie
  stable du nom avec { "contains": "..." }, jamais la donnée elle-même.
- « Le premier de la liste » se traduit par la position — "nth": 0 dans le
  "within" de la liste — pas par le nom de l'élément qui est premier
  aujourd'hui.
- Pour ouvrir une page dont le chemin est connu, préfère "navigate" à un clic :
  moins fragile qu'un lien dont le libellé peut changer.
- Si plusieurs éléments correspondent, lève l'ambiguïté avec "within"
  (le conteneur) de préférence, sinon avec "nth". Une cible ambiguë est
  refusée : le moteur n'a pas le droit de choisir à ta place.
- Quand la ligne visée porte #identifiant, ajoute "fallback": { "testId":
  "identifiant" } — c'est le filet si le libellé change. Sinon, pas de
  fallback.

Règles pour les captures :
- La cible d'une capture se localise par sa structure, JAMAIS par la valeur
  qu'elle extrait : cibler « le texte "129,00 €" » pour capturer un prix casse
  au premier changement de prix.
- Un montant, un total, une quantité se capturent avec "extract": "number",
  pas "text" : c'est ce qui permet de les comparer.

Règles pour les assertions :
- La clé est le texte exact de l'assertion, recopié du scénario.
- L'assertion doit être VRAIE sur l'écran qu'on te montre. On enregistre un
  état connu comme bon : une assertion fausse ici serait un test faux.
- Une valeur peut référencer une capture avec {{nom}}, y compris dans le nom
  d'une cible.

Une intention se traduit souvent en plusieurs gestes : « renseigner l'adresse »
ou « se connecter » sont plusieurs actions, dans l'ordre — mais tous sur
l'écran qu'on te montre : chaque cible est vérifiée contre cet écran avant
toute exécution.`;

export interface StepPromptInput {
  intent: string;
  tree: string;
  location: string;
  expectations: string[];
  /**
   * Nom → description écrite par l'auteur du scénario (« prix : le prix
   * affiché »). C'est la seule intention dont on dispose pour cadrer la
   * capture : ne transmettre que les noms forçait le modèle à deviner.
   */
  captures: Record<string, string>;
  availableCaptures: Record<string, string>;
}

function captureLines(captures: Record<string, string>): string[] {
  return Object.entries(captures).map(([name, description]) => `- ${name} : ${description}`);
}

export function stepMessage(input: StepPromptInput): string {
  const parts = [`Écran courant (${input.location}) :`, '', input.tree, '', `Intention : ${input.intent}`];

  if (Object.keys(input.captures).length > 0) {
    parts.push('', 'Captures à produire :', ...captureLines(input.captures));
  }
  if (input.expectations.length > 0) {
    parts.push('', 'Assertions à traduire, à recopier telles quelles en clé :');
    for (const expectation of input.expectations) parts.push(`- ${expectation}`);
  }

  const available = Object.entries(input.availableCaptures);
  if (available.length > 0) {
    parts.push('', 'Captures déjà disponibles, référençables par {{nom}} :');
    for (const [name, value] of available) parts.push(`- {{${name}}} = ${value}`);
  }

  return parts.join('\n');
}

/**
 * Le retour d'erreur est ce qui rend la boucle fiable : chaque proposition est
 * confrontée à l'application réelle, et l'échec revient au modèle formulé dans
 * le vocabulaire qu'il vient d'employer.
 */
export function retryMessage(errors: string[], tree?: string): string {
  const parts = ['Ta proposition a été rejetée :'];
  for (const error of errors) parts.push(`- ${error}`);
  parts.push('', 'Corrige et propose à nouveau.');
  if (tree !== undefined) parts.push('', 'Écran courant :', '', tree);
  return parts.join('\n');
}

export function checksMessage(input: {
  tree: string;
  expectations: string[];
  captures: Record<string, string>;
  availableCaptures: Record<string, string>;
}): string {
  const parts = ['Les actions ont été exécutées. Voici l\'écran obtenu :', '', input.tree, ''];

  if (Object.keys(input.captures).length > 0) {
    parts.push('Captures à produire depuis cet écran :', ...captureLines(input.captures));
  }
  if (input.expectations.length > 0) {
    parts.push('', 'Assertions à traduire, vraies sur cet écran :');
    for (const expectation of input.expectations) parts.push(`- ${expectation}`);
  }
  const available = Object.entries(input.availableCaptures);
  if (available.length > 0) {
    parts.push('', 'Captures disponibles :');
    for (const [name, value] of available) parts.push(`- {{${name}}} = ${value}`);
  }
  return parts.join('\n');
}
