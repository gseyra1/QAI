/**
 * Capacités de session supplémentaires, partagées par le pilote, la
 * configuration et la ligne de commande — trois endroits qui doivent refuser
 * la même chose.
 *
 * Le passage existe pour ce que QAI ne sait pas deviner : la signature de
 * WebDriverAgent sur un appareil réel, `appium:noReset`,
 * `appium:newCommandTimeout`. Il ne doit jamais devenir une seconde façon de
 * poser ce que QAI pose déjà : un `platformName` ou un `automationName`
 * remplacé ferait piloter autre chose que ce que le rapport annonce, et un
 * `appium:bundleId` glissé ici contredirait `--app` sans que personne ne sache
 * lequel l'a emporté. Ces clés sont refusées plutôt que d'avoir une règle de
 * priorité que personne ne lit.
 */

/** Clés que QAI pose lui-même, sans préfixe, et ce qui les commande. */
const OWNED: ReadonlyMap<string, string> = new Map([
  ['platformName', 'always "iOS"'],
  ['automationName', 'always "XCUITest"'],
  ['app', 'use --app'],
  ['bundleId', 'use --app'],
  ['udid', 'use --device'],
  ['deviceName', 'use --device'],
  ['platformVersion', 'use --platform-version'],
]);

const PREFIX = 'appium:';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownedKey(keys: string[]): string | undefined {
  return keys.find((key) => OWNED.has(key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key));
}

/**
 * Ce qui ne va pas dans ces capacités, ou `undefined`.
 *
 * `appium:options` est regardé aussi : Appium y range des capacités sans
 * préfixe, et un `automationName` caché là passerait sinon le contrôle.
 */
export function capabilitiesProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return 'must be a JSON object';
  const nested = value[`${PREFIX}options`];
  if (nested !== undefined && !isRecord(nested)) return `"${PREFIX}options" must be an object`;
  const key = ownedKey(Object.keys(value)) ?? (nested !== undefined ? ownedKey(Object.keys(nested)) : undefined);
  if (key === undefined) return undefined;
  const bare = key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key;
  return `"${key}" is set by QAI (${OWNED.get(bare) ?? ''})`;
}
