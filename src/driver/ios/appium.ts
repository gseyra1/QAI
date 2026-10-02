/**
 * Client W3C WebDriver minimal, sur `fetch`.
 *
 * Appium parle le protocole W3C : un corps JSON en requête, `{ value }` en
 * réponse, `{ value: { error, message } }` en cas d'échec. Une bibliothèque
 * cliente ajouterait une dépendance d'exécution pour une vingtaine de lignes
 * de transport — et le paquet n'en accepte que deux.
 */

/** Clé W3C d'une référence d'élément (WebDriver, « web element identifier »). */
export const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

/** Le serveur a répondu par une erreur W3C, ou n'a pas répondu du tout. */
export class AppiumError extends Error {
  /** Code d'erreur W3C (« no such alert »), ou `unreachable`. */
  readonly error: string;
  readonly status: number;

  constructor(message: string, error: string, status: number) {
    super(message);
    this.name = 'AppiumError';
    this.error = error;
    this.status = status;
  }
}

export interface RequestOptions {
  /** Nom de la commande, repris dans le message d'erreur. */
  command: string;
  /**
   * Valeurs à masquer dans un message renvoyé par le serveur.
   *
   * Un message d'erreur d'Appium peut recopier ce qui a été tapé ; or il finit
   * dans un rapport, donc dans les journaux d'une CI. Le corps de la requête,
   * lui, n'est jamais repris.
   */
  redact?: string[];
  /** Délai propre à la commande ; la création de session est longue. */
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Première ligne, bornée : Appium joint volontiers une pile complète au
 * message, illisible dans un rapport d'étape.
 */
function summarize(message: string, redact: string[]): string {
  let out = message.split('\n')[0] ?? '';
  for (const secret of redact) {
    if (secret !== '') out = out.split(secret).join('***');
  }
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

export class AppiumClient {
  readonly #base: string;
  readonly #timeoutMs: number;

  constructor(serverUrl: string, timeoutMs: number) {
    // Appium 1 servait sous « /wd/hub », Appium 2 et 3 à la racine : le chemin
    // éventuel de l'URL est conservé tel quel, seule la barre finale tombe.
    this.#base = serverUrl.replace(/\/+$/, '');
    this.#timeoutMs = timeoutMs;
  }

  get serverUrl(): string {
    return this.#base;
  }

  async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown,
    options: RequestOptions,
  ): Promise<unknown> {
    const redact = options.redact ?? [];
    const init: RequestInit = {
      method,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      signal: AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    let response: Response;
    try {
      response = await fetch(`${this.#base}${path}`, init);
    } catch (error) {
      const cause = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      throw new AppiumError(
        `${options.command} failed: cannot reach the Appium server at ${this.#base} (${summarize(cause, redact)})`,
        'unreachable',
        0,
      );
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text === '' ? {} : JSON.parse(text);
    } catch {
      throw new AppiumError(
        `${options.command} failed: HTTP ${response.status}, the response is not JSON`,
        'unknown error',
        response.status,
      );
    }

    const value = isRecord(payload) ? payload['value'] : undefined;
    if (isRecord(value) && typeof value['error'] === 'string') {
      const message = typeof value['message'] === 'string' ? value['message'] : '';
      throw new AppiumError(
        `${options.command} failed: ${value['error']}${message !== '' ? ` — ${summarize(message, redact)}` : ''}`,
        value['error'],
        response.status,
      );
    }
    if (!response.ok) {
      throw new AppiumError(`${options.command} failed: HTTP ${response.status}`, 'unknown error', response.status);
    }
    return value ?? null;
  }
}
