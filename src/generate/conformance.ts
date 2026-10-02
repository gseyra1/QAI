import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { Resolution } from '../resolution/types.ts';
import { serializeResolution } from '../resolution/save.ts';
import type { GenerateInput, GenerateResult } from './generate.ts';
import { generateResolution as generate } from './generate.ts';

/**
 * Aide de test : ce que la génération écrit est-il conforme au schéma publié ?
 *
 * Jamais importée par le moteur — ajv n'est qu'une dépendance de
 * développement. Chaque test qui génère passe par elle : un modèle en mode
 * JSON simple a déjà fait versionner par QAI un fichier que son propre schéma
 * refusait, et seule une confrontation systématique empêche que ça revienne.
 * On valide la forme sérialisée, celle qui part dans git.
 */
const schema: unknown = JSON.parse(readFileSync('schema/resolution.schema.json', 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
// Le module est CommonJS : selon l'interopérabilité, la fonction est l'export
// par défaut ou sa propriété `default`.
const plugin = addFormats as unknown as { default?: (instance: Ajv2020) => void } & ((instance: Ajv2020) => void);
(plugin.default ?? plugin)(ajv);
const validate = ajv.compile(schema as object);

/** Les violations du schéma, ou `null` si le fichier écrit est conforme. */
export function schemaViolations(resolution: Resolution): string | null {
  const written: unknown = JSON.parse(serializeResolution(resolution));
  return validate(written) ? null : JSON.stringify(validate.errors, null, 2);
}

/**
 * `generateResolution`, plus la confrontation au schéma de tout ce qu'elle
 * rend — y compris une résolution incomplète, qui est écrite elle aussi.
 * Les tests de génération l'importent à la place de l'original.
 */
export async function generateResolution(input: GenerateInput): Promise<GenerateResult> {
  const result = await generate(input);
  const violations = schemaViolations(result.resolution);
  if (violations !== null) {
    throw new Error(`the generated resolution violates schema/resolution.schema.json:\n${violations}`);
  }
  return result;
}
