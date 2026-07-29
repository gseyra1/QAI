import type { Role } from '../driver/types.ts';

const ROLES: readonly Role[] = [
  'button', 'link', 'text', 'heading', 'image', 'textbox', 'searchbox', 'combobox',
  'checkbox', 'radio', 'switch', 'slider', 'list', 'listitem', 'table', 'row',
  'cell', 'tab', 'tablist', 'dialog', 'menu', 'menuitem', 'progressbar', 'alert', 'group',
];

/**
 * Un locator, imbriqué jusqu'à `depth` niveaux de conteneur.
 *
 * `within` est récursif dans les types, mais la récursion est ici **dépliée**
 * volontairement : les schémas récursifs ne sont pas supportés par le décodage
 * contraint de la plupart des fournisseurs, et un fournisseur qui ne peut pas
 * contraindre la sortie ne peut pas être branché. Deux niveaux de conteneur
 * couvrent tout ce qu'on rencontre en pratique.
 */
function locator(depth: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    role: { enum: ROLES },
    name: {
      oneOf: [
        { type: 'string', description: 'nom accessible exact' },
        {
          type: 'object',
          properties: { contains: { type: 'string' } },
          required: ['contains'],
          additionalProperties: false,
        },
      ],
    },
    nth: { type: 'integer', minimum: 0, description: 'index, uniquement si plusieurs correspondances sont légitimes' },
  };
  if (depth > 0) properties['within'] = locator(depth - 1);

  return { type: 'object', properties, additionalProperties: false };
}

function target(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      primary: locator(2),
      fallback: {
        type: 'object',
        properties: { testId: { type: 'string' }, selector: { type: 'string' } },
        additionalProperties: false,
        description: 'repli technique, seulement si la page expose un identifiant de test',
      },
    },
    required: ['primary'],
    additionalProperties: false,
  };
}

function action(kind: string, extra: Record<string, unknown> = {}, required: string[] = []): Record<string, unknown> {
  return {
    type: 'object',
    properties: { kind: { const: kind }, ...extra },
    required: ['kind', ...required],
    additionalProperties: false,
  };
}

const CHECKS = ['visible', 'absent', 'textEquals', 'textContains', 'countAtLeast', 'numberEquals', 'stateIs'];

function captures(): Record<string, unknown> {
  return {
    type: 'object',
    description: 'valeurs à extraire de l\'écran, réutilisables plus loin via {{nom}}',
    additionalProperties: {
      type: 'object',
      properties: { from: locator(2), extract: { enum: ['text', 'value', 'number'] } },
      required: ['from', 'extract'],
      additionalProperties: false,
    },
  };
}

function assertions(): Record<string, unknown> {
  return {
    type: 'object',
    description: 'clé = texte exact de l\'assertion du scénario, valeur = sa forme machine',
    additionalProperties: {
      type: 'object',
      properties: {
        check: { enum: CHECKS },
        target: locator(2),
        value: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          description: 'peut référencer une capture, ex. "{{prix}}"',
        },
      },
      required: ['check', 'target'],
      additionalProperties: false,
    },
  };
}

/**
 * Second tour : les actions sont déjà exécutées et validées, on ne reprend que
 * les captures et les assertions contre l'écran réellement obtenu.
 */
export function checksProposalSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: { captures: captures(), assertions: assertions() },
    additionalProperties: false,
  };
}

/**
 * Le schéma de réponse imposé au modèle : la forme machine d'une étape.
 *
 * C'est le contrat entre le modèle et le moteur. QAI ne lit jamais de prose ;
 * il exige cet objet, ce qui rend l'échec du modèle visible immédiatement, en
 * validation, plutôt que six étapes plus loin.
 */
export function stepProposalSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        minItems: 1,
        description: 'les gestes primitifs qui réalisent l\'intention, dans l\'ordre',
        items: {
          oneOf: [
            action('navigate', { to: { type: 'string' } }, ['to']),
            action('click', { target: target() }, ['target']),
            action('fill', { target: target(), value: { type: 'string' } }, ['target', 'value']),
            action('select', { target: target(), option: { type: 'string' } }, ['target', 'option']),
            action('press', { key: { type: 'string' } }, ['key']),
            action('scrollTo', { target: target() }, ['target']),
            action('hover', { target: target() }, ['target']),
          ],
        },
      },
      captures: captures(),
      assertions: assertions(),
    },
    required: ['actions'],
    additionalProperties: false,
  };
}
