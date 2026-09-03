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
        { type: 'string', description: 'exact accessible name' },
        {
          type: 'object',
          properties: { contains: { type: 'string' } },
          required: ['contains'],
          additionalProperties: false,
        },
      ],
    },
    nth: { type: 'integer', minimum: 0, description: 'index, only when several matches are legitimate' },
  };
  if (depth > 0) properties['within'] = locator(depth - 1);

  return { type: 'object', properties, additionalProperties: false };
}

export function targetSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      primary: locator(2),
      fallback: {
        type: 'object',
        properties: { testId: { type: 'string' }, selector: { type: 'string' } },
        additionalProperties: false,
        description: 'technical fallback, only if the page exposes a test id',
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

/** Les seules vérifications sans cible : une URL n'est pas un nœud de l'arbre. */
const URL_CHECKS = ['urlContains', 'urlEquals'];

/** Ce que l'application a FAIT pendant l'étape, et qui ne se voit pas à l'écran. */
const OBSERVATION_CHECKS = ['noFailedRequests', 'noConsoleErrors'];

function captures(): Record<string, unknown> {
  return {
    type: 'object',
    description: 'values to extract from the screen, reusable later via {{name}}',
    additionalProperties: {
      type: 'object',
      properties: { from: locator(2), extract: { enum: ['text', 'value', 'number'] } },
      required: ['from', 'extract'],
      additionalProperties: false,
    },
  };
}

/**
 * Deux branches, parce que ce sont deux formes réellement différentes.
 *
 * Une vérification d'URL n'a pas de cible. Rendre `target` facultatif partout
 * inviterait le modèle à l'omettre là où il est indispensable : garder chaque
 * branche stricte est ce qui laisse l'erreur détectable au décodage, plutôt
 * qu'à l'exécution six étapes plus loin.
 */
function assertions(): Record<string, unknown> {
  return {
    type: 'object',
    description: 'key = exact text of the scenario assertion, value = its machine form',
    additionalProperties: {
      oneOf: [
        {
          type: 'object',
          properties: {
            check: { enum: CHECKS },
            target: locator(2),
            value: {
              oneOf: [{ type: 'string' }, { type: 'number' }],
              description: 'can reference a capture, e.g. "{{price}}"',
            },
          },
          required: ['check', 'target'],
          additionalProperties: false,
        },
        {
          type: 'object',
          description: 'check on the current address: a redirect, a denied access, a navigation',
          properties: {
            check: { enum: URL_CHECKS },
            value: {
              type: 'string',
              description:
                'urlContains: a fragment is enough (e.g. "/login"). urlEquals: the whole URL, compared as-is, trailing slash and query included.',
            },
          },
          required: ['check', 'value'],
          additionalProperties: false,
        },
        {
          type: 'object',
          description:
            'check on what the application DID during the step: network calls, console',
          properties: {
            check: { enum: OBSERVATION_CHECKS },
            allow: {
              type: 'array',
              items: { type: 'string' },
              description:
                'tolerated URL or message fragments, when a failure is the expected answer',
            },
          },
          required: ['check'],
          additionalProperties: false,
        },
      ],
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
        description: 'the primitive gestures that carry out the intent, in order',
        items: {
          oneOf: [
            action('navigate', { to: { type: 'string' } }, ['to']),
            action('click', { target: targetSchema() }, ['target']),
            action('fill', { target: targetSchema(), value: { type: 'string' } }, ['target', 'value']),
            action('select', { target: targetSchema(), option: { type: 'string' } }, ['target', 'option']),
            action('press', { key: { type: 'string' } }, ['key']),
            action('scrollTo', { target: targetSchema() }, ['target']),
            action('hover', { target: targetSchema() }, ['target']),
            action(
              'upload',
              {
                target: targetSchema(),
                files: {
                  type: 'array',
                  minItems: 1,
                  items: { type: 'string' },
                  description:
                    'paths relative to the scenario file; target = the input[type=file], even hidden',
                },
              },
              ['target', 'files'],
            ),
            action(
              'expectDialog',
              {
                response: { enum: ['accept', 'dismiss'] },
                promptText: { type: 'string', description: 'only for a prompt()' },
              },
              ['response'],
            ),
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

/**
 * Ce que le réparateur a le droit de rendre : une cible, et une explication.
 *
 * Le schéma n'expose ni assertion ni action : le réparateur ne peut
 * structurellement pas toucher à ce qui est affirmé, ni ajouter ou supprimer un
 * geste. La règle de sécurité est ici doublée par le contrat de sortie.
 */
export function healProposalSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      target: targetSchema(),
      note: {
        type: 'string',
        description:
          'one sentence, for a human who will review the diff: what changed in the application',
      },
    },
    required: ['target', 'note'],
    additionalProperties: false,
  };
}
