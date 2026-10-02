import type { Platform } from '../driver/types.ts';

/**
 * Les adresses d'une résolution, rapportées à la base de l'application.
 *
 * Un seul module pour l'écriture (la génération ramène une adresse absolue à
 * une forme relative) et pour la lecture (le rejeu résout cette forme contre
 * la base du moment) : deux règles écrites séparément finiraient par dériver,
 * et une adresse écrite d'une façon serait relue d'une autre.
 */

/**
 * La base, terminée par « / ».
 *
 * Sans la barre finale, `new URL('eleves', 'https://x/ecole')` rend
 * `https://x/eleves` : le dernier segment est traité comme un fichier, pas
 * comme un dossier, et le préfixe disparaît silencieusement.
 */
export function normalizedBase(baseUrl: string): URL {
  const url = new URL(baseUrl);
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url;
}

/**
 * Une valeur qui porte un schéma (« https: », « about: ») est absolue : la
 * base n'y change rien. C'est la règle même de `new URL`, reprise pour ne pas
 * la contredire.
 */
export function hasScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

/** Une adresse complète, hôte compris : ce que le modèle recopie de la barre d'adresse. */
export function isAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

/**
 * La forme relative à la base d'une adresse de la même origine.
 *
 * Rend `null` pour une autre origine — une sortie délibérée de l'application,
 * pas une adresse recopiée par accident — ou pour ce qui ne se lit pas comme
 * une adresse : on n'y touche pas, la vérification en dira plus que nous.
 */
export function relativeToBase(value: string, baseUrl: string): string | null {
  try {
    const root = normalizedBase(baseUrl);
    const target = new URL(value, root);
    if (target.origin !== root.origin) return null;

    /**
     * Relatif à la BASE, pas à l'origine.
     *
     * Une application servie sous un préfixe — « https://staging/ecole/ » —
     * perdait ce préfixe : un chemin absolu « /ecole/eleves » écrit à la
     * génération devient « https://autre-hote/ecole/eleves » au rejeu si la
     * base change de préfixe, et « /eleves » écrasait carrément le préfixe.
     * Une forme relative suit la base où qu'elle soit montée.
     */
    // La requête et le fragment tels qu'écrits, pas `search` et `hash` : ceux-ci
    // rendent « » pour un « ? » ou un « # » vide, et « x? » réécrit en « x »
    // ne désigne plus la même adresse — une vérification exacte deviendrait
    // fausse sur l'écran même où elle a été écrite. Ni le chemin ni l'hôte ne
    // contiennent ces deux caractères en clair : le premier marque la coupure.
    const cut = target.href.search(/[?#]/);
    const suffix = cut === -1 ? '' : target.href.slice(cut);
    if (!target.pathname.startsWith(root.pathname)) {
      return `${target.pathname}${suffix}`;
    }
    let head = target.pathname.slice(root.pathname.length);
    // La base elle-même ne donne pas une chaîne vide, qui se lirait comme un
    // champ oublié : « . » est la référence relative au dossier courant, et
    // `new URL('.', base)` rend exactement la base.
    if (head === '' && suffix === '') return '.';
    // « a:b » se relirait comme un schéma, « /x » (issu de « //x ») comme un
    // chemin d'origine : « ./ » garde la forme relative à la base.
    if (head.startsWith('/') || hasScheme(head)) head = `./${head}`;
    return `${head}${suffix}`;
  } catch {
    return null;
  }
}

/**
 * Une valeur que l'analyse d'URL réécrirait en silence.
 *
 * `new URL` ôte les blancs en tête et en queue, efface tabulations et sauts de
 * ligne, et résout « » en la base elle-même. Une capture revenue vide au rejeu
 * ferait alors de « {{adresseCommande}} » l'affirmation « on est à la
 * racine » : un vert qui ne prouve rien, là où la comparaison brute échouait.
 */
export function isDegenerateUrlValue(value: string): boolean {
  return value === '' || /^[\x00-\x20]|[\x00-\x20]$|[\t\n\r]/.test(value);
}

/**
 * L'adresse attendue, résolue contre la base quand elle est relative.
 *
 * Sans base, sur une valeur absolue ou dégénérée, la valeur est rendue telle
 * quelle : la comparaison reste alors la comparaison brute d'avant la v3, qui
 * ne peut pas confondre une valeur vide avec la racine.
 */
export function resolveAgainstBase(value: string, baseUrl: string | undefined): string {
  if (baseUrl === undefined || hasScheme(value) || isDegenerateUrlValue(value)) return value;
  try {
    return new URL(value, normalizedBase(baseUrl)).toString();
  } catch {
    return value;
  }
}

/**
 * La base qui vaut pour les vérifications d'URL.
 *
 * Sur le web seulement : ailleurs, `location` est un identifiant d'écran ou
 * d'activité, et l'entrée de lancement un chemin de bundle ou un lien profond.
 * Résoudre « MainActivity » contre « monapp://accueil/ » fabriquerait une
 * adresse que personne n'a écrite.
 */
export function checkBaseFor(platform: Platform, baseUrl: string | undefined): string | undefined {
  return platform === 'web' ? baseUrl : undefined;
}

/**
 * Une navigation qui se passe de base : « . » ou « / » (relancer), ou un lien
 * profond — un schéma suivi d'autre chose qu'un port. « localhost:3000/x » a la
 * forme d'un schéma, mais c'est une adresse web recopiée sans « http:// ».
 *
 * Hors du web, c'est la seule forme qui désigne quelque chose : la génération
 * la refuse au modèle, la cohérence la refuse au cache.
 */
export function isBaselessNavigation(to: string): boolean {
  const trimmed = to.trim();
  return trimmed === '.' || trimmed === '/' || /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed);
}

/**
 * Ce que partagent toutes les adresses de l'application.
 *
 * Hors du web, `location` vaut « <identifiant d'application>/<écran> » : tout
 * ce qui tient dans « <identifiant>/ » est vrai sur chaque écran. Sur le web,
 * c'est la base elle-même : chaque page de l'application commence par elle,
 * donc « localhost:4173 », « / » ou une valeur vide y sont vrais partout.
 * Dans les deux cas, un `urlContains` de cette forme affirmerait « on est sur
 * l'écran X » sans pouvoir échouer.
 */
export function screenAgnosticPrefix(
  platform: Platform,
  location: string,
  baseUrl?: string,
): string | undefined {
  if (platform === 'web') {
    if (baseUrl === undefined) return undefined;
    try {
      return normalizedBase(baseUrl).href;
    } catch {
      return undefined;
    }
  }
  const cut = location.indexOf('/');
  return cut === -1 ? `${location}/` : location.slice(0, cut + 1);
}
