/**
 * Lecture du point d'entrée iOS, partagée par le pilote, la configuration et
 * la ligne de commande — trois endroits qui doivent trancher de la même façon
 * entre « identifiant d'app » et « chemin de bundle ».
 */

/**
 * Un bundle à installer : `.app`, `.ipa`, ou `.app` zippé, comme
 * `appium:app` l'accepte. Une barre finale est tolérée : un `.app` est un
 * dossier, et la complétion du shell l'ajoute.
 */
export function isAppPath(entry: string): boolean {
  return /\.(app|ipa|zip)\/?$/i.test(entry.trim());
}

/**
 * Identifiant de bundle en notation DNS inversée : lettres, chiffres, tirets,
 * points, avec au moins un point. Volontairement étroit : une URL de base web
 * passée par erreur à `--app` doit être refusée, pas transmise à Appium qui
 * répondrait par une erreur de session illisible.
 */
export function isBundleId(entry: string): boolean {
  return /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(entry);
}

/**
 * UDID d'un simulateur (UUID), d'un appareil récent (8-16 hexadécimaux) ou
 * ancien (40 hexadécimaux). Tout le reste est lu comme un nom d'appareil :
 * « iPhone 16 » ne ressemble à aucun de ces formats.
 */
export function isUdid(device: string): boolean {
  return (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(device) ||
    /^[0-9a-f]{8}-[0-9a-f]{16}$/i.test(device) ||
    /^[0-9a-f]{40}$/i.test(device)
  );
}
