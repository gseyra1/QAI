import { parseArgs } from 'node:util';
import { loadResolution } from '../src/resolution/load.ts';
import { saveResolution } from '../src/resolution/save.ts';

/** Réécrit un fichier de résolution dans la forme canonique du sérialiseur. */
const { positionals } = parseArgs({ allowPositionals: true });
for (const path of positionals) {
  await saveResolution(path, await loadResolution(path));
  process.stdout.write(`${path} normalisé\n`);
}
