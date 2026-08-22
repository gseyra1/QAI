export const SYSTEM_PROMPT = `Tu traduis une intention d'utilisateur en gestes machine sur une interface.

On te donne l'arbre de l'écran courant, indenté, où chaque ligne est :
  <rôle> "<nom accessible>" [état]

Tu rends les actions qui réalisent l'intention, et le cas échéant les captures
et les assertions demandées.

Règles de ciblage, sans exception :
- Une cible se décrit par son rôle et son nom accessible, jamais par un
  sélecteur CSS ni un XPath. C'est ce qui rend le test rejouable sur mobile.
- Le nom doit correspondre exactement à celui de l'arbre. Si le nom exact est
  instable (il contient un compteur, une date, un montant), utilise
  { "contains": "..." } sur la partie stable.
- Si plusieurs éléments correspondent, lève l'ambiguïté avec "within"
  (le conteneur) de préférence, sinon avec "nth". Une cible ambiguë est
  refusée : le moteur n'a pas le droit de choisir à ta place.
- N'utilise "fallback" que si la page expose réellement un identifiant de test.

Règles pour les assertions :
- La clé est le texte exact de l'assertion, recopié du scénario.
- L'assertion doit être VRAIE sur l'écran qu'on te montre. On enregistre un
  état connu comme bon : une assertion fausse ici serait un test faux.
- Une valeur peut référencer une capture avec {{nom}}, y compris dans le nom
  d'une cible.
- Quand l'assertion parle de l'adresse — une redirection, un accès refusé, une
  navigation — utilise "urlContains" (un fragment stable, ex. "/connexion") ou
  "urlEquals" (l'URL entière, comparée telle quelle). Ces deux vérifications
  n'ont pas de "target" : elles ne portent sur aucun élément.

Une intention se traduit souvent en plusieurs gestes : « renseigner l'adresse »
ou « se connecter » sont plusieurs actions, dans l'ordre.`;

export interface StepPromptInput {
  intent: string;
  tree: string;
  location: string;
  expectations: string[];
  captureNames: string[];
  availableCaptures: Record<string, string>;
}

export function stepMessage(input: StepPromptInput): string {
  const parts = [`Écran courant (${input.location}) :`, '', input.tree, '', `Intention : ${input.intent}`];

  if (input.captureNames.length > 0) {
    parts.push('', `Captures à produire : ${input.captureNames.join(', ')}`);
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
  /** Sans elle, une assertion d'URL serait à deviner. */
  location: string;
  expectations: string[];
  captureNames: string[];
  availableCaptures: Record<string, string>;
}): string {
  const parts = [
    `Les actions ont été exécutées. Voici l'écran obtenu (${input.location}) :`,
    '',
    input.tree,
    '',
  ];

  if (input.captureNames.length > 0) {
    parts.push(`Captures à produire depuis cet écran : ${input.captureNames.join(', ')}`);
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
