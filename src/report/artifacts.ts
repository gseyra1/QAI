import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Écrit les captures d'échec dans un dossier et rend leur nom.
 *
 * Le moteur ne connaît pas le disque : il rend des octets et un nom, et c'est
 * ici qu'on décide où ils atterrissent. En CI, ce dossier est publié comme
 * artefact du run.
 */
export function artifactWriter(dir: string): (name: string, bytes: Uint8Array) => Promise<string> {
  let ready: Promise<void> | null = null;

  return async (name, bytes) => {
    ready ??= mkdir(dir, { recursive: true }).then(() => undefined);
    await ready;
    // Un nom de fichier ne doit jamais échapper au dossier prévu, même si un
    // identifiant de scénario contenait un séparateur de chemin.
    const safe = name.replace(/[^\w.-]+/g, '_');
    await writeFile(join(dir, safe), bytes);
    return safe;
  };
}
