import type { PreparedState } from '../src/driver/types.ts';
import type { StateProvider, StateRequest } from '../src/state/types.ts';

/**
 * Traduit les états nommés d'un scénario en session installée.
 *
 * QAI ne sait rien de votre authentification ni de vos données de test. Vous
 * écrivez cette méthode — un appel à votre API d'amorçage, une connexion
 * technique qui rend un jeton — et QAI installe le résultat dans le navigateur
 * avant la première étape.
 *
 *   npm run qai -- run qa/ --base-url $URL --states ./qa/states.ts
 *
 * Pourquoi ne pas se connecter par le formulaire dans le scénario ? Parce que
 * ce serait lent, fragile, et que cinquante parcours testeraient alors la page
 * de connexion au lieu de ce qu'ils visent.
 */
export default {
  async prepare(request: StateRequest): Promise<PreparedState> {
    switch (request.given.state) {
      case 'client-connecte': {
        // Chez vous : un appel à votre API qui rend un jeton de session.
        //   const { token } = await fetch(`${request.baseUrl}/api/test/login`, …)
        //   return { cookies: [{ name: 'session', value: token }] };
        return { storage: { qai_user: 'Alice' } };
      }

      case 'visiteur-anonyme':
      case undefined:
        return {};

      default:
        throw new Error(`état inconnu : ${request.given.state}`);
    }
  },
} satisfies StateProvider;
