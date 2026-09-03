import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Résout le chemin d'un fichier à téléverser, et refuse ce qui sort du dossier
 * du scénario.
 *
 * Deux défauts en un, et le second explique pourquoi le premier passait
 * inaperçu.
 *
 * **Le cadrage.** `path.resolve` abandonne purement et simplement sa base dès
 * que le second argument est absolu, et laisse `..` remonter aussi haut qu'on
 * veut. Un scénario pouvait donc désigner n'importe quel fichier de la machine
 * — une clé privée, un `.env`, un jeton — et le moteur l'envoyait de lui-même
 * à l'application testée. Ce n'est pas un risque théorique de fichier écrit à
 * la main : les actions sortent d'un modèle qui lit l'écran, et un écran est
 * une entrée non fiable.
 *
 * **La cohérence.** La génération résolvait depuis le répertoire courant, le
 * rejeu depuis le dossier du scénario. Le même chemin ne désignait donc pas le
 * même fichier selon la commande — ce qui produit une résolution qui marche à
 * l'écriture et casse au premier rejeu, l'échec le plus coûteux à diagnostiquer
 * puisque rien n'a changé entre les deux.
 *
 * Le refus est volontairement strict : élargir le cadre plus tard est additif,
 * le resserrer ne l'est pas.
 */
export function resolveUpload(baseDir: string, file: string): string {
  const base = resolve(baseDir);
  const full = resolve(base, file);

  /**
   * `relative` répond à la seule question qui compte : pour aller de la base
   * au fichier, faut-il sortir ? Trois façons d'échouer — remonter, repartir
   * d'une autre racine (un autre volume sous Windows, où `relative` rend un
   * chemin absolu), ou ne pas bouger du tout parce que le chemin désigne le
   * dossier lui-même.
   *
   * Le test porte sur `..` suivi du séparateur, pas sur le préfixe `..` : un
   * fichier nommé « ..cache » est légitime.
   */
  const inside = relative(base, full);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(outsideMessage(file, base));
  }

  /**
   * Le cadrage lexical ne voit pas les liens symboliques : un lien placé DANS
   * le dossier du scénario mais pointant dehors passe la première garde, et
   * `readFile` suit le lien. Un dossier de scénarios est un artefact versionné
   * et partagé — git préserve les liens —, donc un dépôt tiers pourrait
   * exfiltrer `~/.ssh/id_rsa`. On résout les liens des deux côtés et on refait
   * le test sur les chemins réels.
   *
   * `realpathSync` exige que le fichier existe : c'est le cas, un téléversement
   * lit un fichier réel. Un chemin inexistant échoue ici plutôt qu'au driver,
   * ce qui est le bon endroit pour le dire.
   */
  let realBase: string;
  let realFull: string;
  try {
    realBase = realpathSync(base);
    realFull = realpathSync(full);
  } catch {
    throw new Error(`upload "${file}": file not found within the scenario directory (${base}).`);
  }
  const realInside = relative(realBase, realFull);
  if (realInside === '' || realInside === '..' || realInside.startsWith(`..${sep}`) || isAbsolute(realInside)) {
    throw new Error(outsideMessage(file, base));
  }

  return full;
}

function outsideMessage(file: string, base: string): string {
  return (
    `upload "${file}": resolves outside the scenario directory (${base}). ` +
    'Keep the fixture within the scenario directory: a test must not be able to read the machine it runs on.'
  );
}
