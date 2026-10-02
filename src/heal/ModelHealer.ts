import type { Driver, ResolvedTarget, UINode } from '../driver/types.ts';
import type { HealRequest, HealResult, Healer } from '../engine/run.ts';
import { renderTree } from '../generate/render.ts';
import { fallbackIssue, targetIssue } from '../generate/proposal.ts';
import { healProposalSchema } from '../generate/schema.ts';
import type { ModelMessage, ModelProvider } from '../model/types.ts';

export const HEAL_SYSTEM_PROMPT = `An automated test can no longer locate a UI element. You must relocate it.

You are given the step's intent, the target that no longer works, the reason
for the failure, and the tree of the current screen — one line per element:
  <role> "<accessible name>" [state] #test-id

You return the new target and a one-sentence explanation.

Rules:
- Look for the element that satisfies the SAME intent. If no element does,
  do not propose a near match: better to fail than to make a test pass on
  something else.
- A target is described by role and accessible name, never by a CSS selector.
- Preserve what made the target stable: never replace a
  { "contains": "..." } form with the exact name displayed today if that name
  contains data (a number, an amount, a date) — it will change on the next
  replay. When the targeted line itself carries #some-id, keep it as
  "fallback": { "testId": "some-id" } — never the #id of another line, such
  as its container.
- If several elements match, disambiguate with "within" or "nth".
- The note will be read by a developer in a review diff. Say what changed in
  the application — "the button label went from X to Y" — not what you did.`;

export interface ModelHealerOptions {
  driver: Driver;
  provider: ModelProvider;
  /** Propositions vérifiées avant d'abandonner l'étape. */
  attempts?: number;
}

interface Proposal {
  target: ResolvedTarget;
  note: string;
}

/**
 * La proposition, ou la raison précise de son refus.
 *
 * La cible est contrôlée clé par clé : une clé de trop serait réinjectée
 * telle quelle dans la résolution, puis versionnée dans un fichier que le
 * schéma publié refuse.
 */
function asProposal(output: unknown): Proposal | string {
  const malformed = 'malformed response: return "target" and "note"';
  if (typeof output !== 'object' || output === null) return malformed;
  const record = output as Record<string, unknown>;
  const target = record['target'];
  const note = record['note'];
  if (typeof note !== 'string' || note.length === 0) return malformed;
  if (typeof target !== 'object' || target === null) return malformed;
  const issue = targetIssue(target, 'target');
  if (issue !== null) return issue;
  return { target: target as ResolvedTarget, note };
}

function describeFailure(request: HealRequest): string {
  if (request.outcome.reason === 'ambiguous') {
    return `${request.outcome.matches} elements matched: the target is ambiguous`;
  }
  if (request.outcome.reason === 'not-visible') return 'the target exists but is not visible';
  return 'no element matches this target anymore';
}

/**
 * L'étage 2 : la même boucle que la génération, appliquée à une seule cible.
 *
 * Ce qui la rend sûre n'est pas le modèle mais la vérification — la proposition
 * est confrontée à l'application avant d'être acceptée. Et le réparateur ne
 * peut, structurellement, rien changer d'autre que la cible : le moteur ne
 * l'appelle que sur un échec de résolution, et son schéma de sortie n'expose
 * ni assertion ni action.
 */
export class ModelHealer implements Healer {
  readonly #driver: Driver;
  readonly #provider: ModelProvider;
  readonly #attempts: number;

  constructor(options: ModelHealerOptions) {
    this.#driver = options.driver;
    this.#provider = options.provider;
    this.#attempts = options.attempts ?? 2;
  }

  async heal(request: HealRequest): Promise<HealResult> {
    const conversation: ModelMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              `Step intent: ${request.intent}`,
              '',
              `Target that no longer works: ${JSON.stringify(request.target.primary)}`,
              `Reason: ${describeFailure(request)}`,
              '',
              `Current screen (${request.snapshot.location}):`,
              '',
              renderTree(request.snapshot.root),
            ].join('\n'),
          },
        ],
      },
    ];

    const rejections: string[] = [];

    for (let attempt = 0; attempt < this.#attempts; attempt += 1) {
      const response = await this.#provider.complete({
        system: HEAL_SYSTEM_PROMPT,
        messages: conversation,
        responseSchema: healProposalSchema(),
      });

      const proposal = asProposal(response.output);
      if (typeof proposal === 'string') {
        rejections.push(proposal);
        conversation.push(
          { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(response.output) }] },
          { role: 'user', content: [{ type: 'text', text: `Rejected: ${proposal}. Fix it.` }] },
        );
        continue;
      }

      let outcome;
      try {
        outcome = await this.#driver.resolve(proposal.target);
      } catch (error) {
        outcome = null;
        rejections.push(error instanceof Error ? error.message : String(error));
      }

      // Même garde qu'à la génération : un repli qui désigne un autre élément
      // agirait sur lui, sans erreur, le jour où `primary` se perd.
      let tree: UINode | null = null;
      const mismatch =
        outcome !== null && outcome.found && !outcome.usedFallback
          ? await fallbackIssue(proposal.target, outcome.node, async () => {
              tree ??= (await this.#driver.observe({ interactiveOnly: true })).root;
              return tree;
            })
          : null;

      if (outcome !== null && outcome.found && mismatch === null) {
        // Un repli technique qui sauve la mise vaut mieux qu'un échec — mais il
        // signifie que l'accessibilité de l'application s'est dégradée, et que
        // ce ciblage ne survivra pas au portage mobile. On le dit.
        return {
          healed: true,
          target: proposal.target,
          note: proposal.note,
          degraded: outcome.usedFallback,
        };
      }

      let reason: string;
      if (outcome === null) reason = rejections.at(-1) ?? 'invalid target';
      else if (outcome.found) reason = mismatch ?? 'invalid target';
      else if (outcome.reason === 'ambiguous') {
        reason = `the new target is ambiguous: ${outcome.matches} elements match — disambiguate with "within" or "nth"`;
      } else if (outcome.reason === 'not-visible') reason = 'the new target exists but is not visible';
      else reason = 'no element matches the new target';

      rejections.push(reason);
      conversation.push(
        { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(response.output) }] },
        { role: 'user', content: [{ type: 'text', text: `Rejected: ${reason}. Fix it.` }] },
      );
    }

    return { healed: false, reason: rejections.join('; ') };
  }
}
