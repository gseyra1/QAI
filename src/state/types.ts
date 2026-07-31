import type { PreparedState } from '../driver/types.ts';
import type { Given } from '../scenario/types.ts';

export interface StateRequest {
  scenarioId: string;
  baseUrl: string;
  given: Given;
}

/**
 * Prépare l'état de départ déclaré par un scénario.
 *
 * QAI ne sait rien de votre authentification ni de vos données de test : c'est
 * vous qui les connaissez. Vous implémentez cette méthode — appel à votre API
 * d'amorçage, obtention d'un jeton de session — et vous rendez l'état que QAI
 * installera dans le navigateur avant la première étape.
 *
 * Un scénario ne construit donc jamais son contexte à coups de clics. Se
 * connecter par le formulaire à chaque parcours serait lent, fragile, et
 * testerait la connexion cinquante fois au lieu du parcours visé.
 */
export interface StateProvider {
  prepare(request: StateRequest): Promise<PreparedState>;
}
