import type { PreparedState } from '../src/driver/types.ts';
import type { StateProvider, StateRequest } from '../src/state/types.ts';

/**
 * Translates a scenario's named states into an installed session.
 *
 * QAI knows nothing about your authentication or your test data. You write
 * this method — a call to your seeding API, a technical login that returns a
 * token — and QAI installs the result in the browser before the first step.
 *
 *   npm run qai -- run qa/ --base-url $URL --states ./qa/states.ts
 *
 * Why not sign in through the form in the scenario? Because it would be slow,
 * fragile, and fifty journeys would then test the login page instead of what
 * they are aiming at.
 */
export default {
  async prepare(request: StateRequest): Promise<PreparedState> {
    switch (request.given.state) {
      case 'client-connecte': {
        // In your project: a call to your API that returns a session token.
        //   const { token } = await fetch(`${request.baseUrl}/api/test/login`, …)
        //   return { cookies: [{ name: 'session', value: token }] };
        return { storage: { qai_user: 'Alice' } };
      }

      case 'visiteur-anonyme':
      case undefined:
        return {};

      default:
        throw new Error(`unknown state: ${request.given.state}`);
    }
  },
} satisfies StateProvider;
