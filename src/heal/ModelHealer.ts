import type { Driver, ResolvedTarget } from '../driver/types.ts';
import type { HealRequest, HealResult, Healer } from '../engine/run.ts';
import { renderTree } from '../generate/render.ts';
import { healProposalSchema } from '../generate/schema.ts';
import type { ModelMessage, ModelProvider } from '../model/types.ts';

export const HEAL_SYSTEM_PROMPT = `Un test automatisé ne retrouve plus un élément d'interface. Tu dois le relocaliser.

On te donne l'intention de l'étape, la cible qui ne fonctionne plus, la raison
de l'échec, et l'arbre de l'écran courant — une ligne par élément :
  <rôle> "<nom accessible>" [état]

Tu rends la nouvelle cible et une phrase d'explication.

Règles :
- Cherche l'élément qui satisfait la MÊME intention. Si aucun élément ne le
  fait, ne propose pas un élément approchant : mieux vaut échouer que faire
  passer un test sur autre chose.
- Une cible se décrit par rôle et nom accessible, jamais par un sélecteur CSS.
- Si plusieurs éléments correspondent, lève l'ambiguïté avec "within" ou "nth".
- La note sera lue par un développeur dans un diff de revue. Dis ce qui a changé
  dans l'application — « le libellé du bouton est passé de X à Y » — pas ce que
  tu as fait.`;

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

function asProposal(output: unknown): Proposal | null {
  if (typeof output !== 'object' || output === null) return null;
  const record = output as Record<string, unknown>;
  const target = record['target'];
  const note = record['note'];
  if (typeof target !== 'object' || target === null) return null;
  if (typeof note !== 'string' || note.length === 0) return null;
  if (!('primary' in target)) return null;
  return { target: target as ResolvedTarget, note };
}

function describeFailure(request: HealRequest): string {
  if (request.outcome.reason === 'ambiguous') {
    return `${request.outcome.matches} éléments correspondaient : la cible est ambiguë`;
  }
  if (request.outcome.reason === 'not-visible') return 'la cible existe mais n\'est pas visible';
  return 'aucun élément ne correspond plus à cette cible';
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
              `Intention de l'étape : ${request.intent}`,
              '',
              `Cible qui ne fonctionne plus : ${JSON.stringify(request.target.primary)}`,
              `Raison : ${describeFailure(request)}`,
              '',
              `Écran courant (${request.snapshot.location}) :`,
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
      if (proposal === null) {
        rejections.push('réponse mal formée');
        conversation.push(
          { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(response.output) }] },
          {
            role: 'user',
            content: [{ type: 'text', text: 'Réponse mal formée. Rends « target » et « note ».' }],
          },
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

      if (outcome !== null && outcome.found) {
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

      const reason =
        outcome === null
          ? (rejections.at(-1) ?? 'cible invalide')
          : outcome.reason === 'ambiguous'
            ? `la nouvelle cible est ambiguë : ${outcome.matches} éléments correspondent — précise avec "within" ou "nth"`
            : outcome.reason === 'not-visible'
              ? 'la nouvelle cible existe mais n\'est pas visible'
              : 'aucun élément ne correspond à la nouvelle cible';

      rejections.push(reason);
      conversation.push(
        { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(response.output) }] },
        { role: 'user', content: [{ type: 'text', text: `Rejeté : ${reason}. Corrige.` }] },
      );
    }

    return { healed: false, reason: rejections.join(' ; ') };
  }
}
