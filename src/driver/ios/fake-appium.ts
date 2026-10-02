import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ELEMENT_KEY } from './appium.ts';
import type { XmlElement } from './xml.ts';
import { parseXml } from './xml.ts';

/**
 * Un faux serveur Appium pour les tests du pilote iOS.
 *
 * Aucun simulateur n'est disponible là où ce pilote a été écrit : la seule
 * preuve possible est que chaque geste produit exactement les appels HTTP
 * documentés. Le faux serveur répond comme XCUITest — mêmes chemins, mêmes
 * enveloppes `{ value }`, mêmes erreurs W3C — et ENREGISTRE tout, pour que
 * les tests affirment la séquence d'appels plutôt qu'un effet supposé.
 */

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
}

export interface Reply {
  status?: number;
  value: unknown;
}

type Handler = (call: Recorded, fake: FakeAppium) => Reply | undefined;

export const FIXTURES = new URL('../../../fixtures/ios/', import.meta.url);

export function fixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf8');
}

function w3cError(status: number, error: string, message: string): Reply {
  return { status, value: { error, message, stacktrace: '' } };
}

interface Step {
  descendant: boolean;
  tag: string;
  position?: number;
  attributes: [string, string][];
}

/**
 * Le sous-ensemble d'XPath 1.0 que le pilote produit : des pas `/Tag[n]`, le
 * premier en `//`, le dernier éventuellement suivi de `[@attr="…"]` (guillemets
 * doubles, simples, ou `concat()`). Tout le reste est refusé, comme le serait
 * un sélecteur invalide : un chemin que le faux ne comprend pas ne doit jamais
 * « trouver » quelque chose.
 */
function parsePath(path: string): Step[] {
  const steps: Step[] = [];
  let at = 0;
  const fail = (): never => {
    throw new Error(`unsupported xpath: ${path}`);
  };
  const literal = (): string => {
    const quote = path[at];
    if (quote === '"' || quote === "'") {
      const end = path.indexOf(quote, at + 1);
      if (end < 0) fail();
      const text = path.slice(at + 1, end);
      at = end + 1;
      return text;
    }
    if (path.startsWith('concat(', at)) {
      at += 'concat('.length;
      let text = '';
      for (;;) {
        while (path[at] === ' ') at += 1;
        text += literal();
        while (path[at] === ' ') at += 1;
        if (path[at] === ',') {
          at += 1;
          continue;
        }
        if (path[at] === ')') {
          at += 1;
          return text;
        }
        fail();
      }
    }
    return fail();
  };
  while (at < path.length) {
    if (path[at] !== '/') fail();
    const descendant = path[at + 1] === '/';
    at += descendant ? 2 : 1;
    const name = /^[A-Za-z][A-Za-z0-9]*/.exec(path.slice(at))?.[0] ?? fail();
    at += name.length;
    const step: Step = { descendant, tag: name, attributes: [] };
    while (path[at] === '[') {
      at += 1;
      const digits = /^[0-9]+/.exec(path.slice(at))?.[0];
      if (digits !== undefined) {
        step.position = Number(digits);
        at += digits.length;
      } else if (path[at] === '@') {
        const attribute = /^@([A-Za-z]+)=/.exec(path.slice(at)) ?? fail();
        at += attribute[0].length;
        step.attributes.push([attribute[1] as string, literal()]);
      } else {
        fail();
      }
      if (path[at] !== ']') fail();
      at += 1;
    }
    steps.push(step);
  }
  return steps;
}

function descendants(element: XmlElement): XmlElement[] {
  return element.children.flatMap((child) => [child, ...descendants(child)]);
}

/** Évalue le chemin sur la source servie, comme WebDriverAgent sur son instantané. */
export function evaluatePath(source: string, path: string): XmlElement[] {
  const document = parseXml(source);
  // Le nœud document virtuel : la racine XML est son seul enfant.
  const top: XmlElement = { tag: '#document', attributes: {}, children: [document] };
  let current: XmlElement[] = [top];
  for (const step of parsePath(path)) {
    // Les parents candidats : ceux du pas, ou tous leurs descendants pour « // ».
    const parents = step.descendant ? current.flatMap((one) => [one, ...descendants(one)]) : current;
    const next: XmlElement[] = [];
    for (const parent of parents) {
      let rank = 0;
      for (const child of parent.children) {
        if (child.tag !== step.tag) continue;
        rank += 1;
        if (step.position !== undefined && rank !== step.position) continue;
        if (step.attributes.some(([name, value]) => child.attributes[name] !== value)) continue;
        next.push(child);
      }
    }
    current = next;
  }
  return current;
}

export class FakeAppium {
  readonly calls: Recorded[] = [];
  readonly sessionId = 'sess-1';
  source = '';
  /**
   * Texte de l'alerte que WebDriverAgent voit, ou null. Qu'elle appartienne à
   * l'application ou au système dépend de la source servie : une alerte
   * d'application y figure, une alerte système non.
   */
  alert: string | null = null;
  activeBundleId = 'com.example.acme';
  #deleted = false;
  #elements = 0;
  readonly #handlers: { method: string; pattern: RegExp; handle: Handler }[] = [];
  readonly #server: Server;
  url = '';

  constructor() {
    this.#server = createServer((request, response) => {
      void this.#serve(request, response);
    });
  }

  static async start(source = ''): Promise<FakeAppium> {
    const fake = new FakeAppium();
    fake.source = source;
    await new Promise<void>((done) => fake.#server.listen(0, '127.0.0.1', done));
    const { port } = fake.#server.address() as AddressInfo;
    fake.url = `http://127.0.0.1:${port}`;
    return fake;
  }

  /** Remplace une réponse ; rendre `undefined` laisse passer au défaut. */
  on(method: string, pattern: RegExp, handle: Handler): void {
    this.#handlers.unshift({ method, pattern, handle });
  }

  /**
   * Les appels sous forme lisible, « POST /execute/sync mobile: tap ».
   *
   * Le préfixe de session est retiré : c'est la séquence des commandes qu'on
   * veut lire dans une assertion, pas l'identifiant répété.
   */
  commands(): string[] {
    return this.calls.map((call) => {
      const path = call.path.replace(`/session/${this.sessionId}`, '');
      const script =
        typeof call.body === 'object' && call.body !== null && 'script' in call.body
          ? ` ${String((call.body as { script: unknown }).script)}`
          : '';
      return `${call.method} ${path}${script}`;
    });
  }

  /** Oublie les appels et les réponses remplacées : chaque test part du défaut. */
  reset(): void {
    this.calls.length = 0;
    this.#handlers.length = 0;
    this.#elements = 0;
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((done) => this.#server.close(() => done()));
  }

  async #serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const call: Recorded = {
      method: request.method ?? 'GET',
      path: request.url ?? '/',
      body: text === '' ? undefined : (JSON.parse(text) as unknown),
    };
    this.calls.push(call);

    let reply: Reply | undefined;
    for (const handler of this.#handlers) {
      if (handler.method !== call.method || !handler.pattern.test(call.path)) continue;
      reply = handler.handle(call, this);
      if (reply !== undefined) break;
    }
    reply ??= this.#default(call);

    response.writeHead(reply.status ?? 200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ value: reply.value }));
  }

  #default(call: Recorded): Reply {
    if (call.method === 'POST' && call.path === '/session') {
      this.#deleted = false;
      return { value: { sessionId: this.sessionId, capabilities: { platformName: 'iOS' } } };
    }

    const prefix = `/session/${this.sessionId}`;
    if (!call.path.startsWith(prefix) || this.#deleted) {
      return w3cError(404, 'invalid session id', 'A session is either terminated or not started');
    }
    const path = call.path.slice(prefix.length);
    const route = `${call.method} ${path}`;

    if (route === 'DELETE ') {
      this.#deleted = true;
      return { value: null };
    }
    if (route === 'GET /source') return { value: this.source };
    if (route === 'GET /screenshot') return { value: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') };

    if (route === 'GET /alert/text') {
      return this.alert === null
        ? w3cError(404, 'no such alert', 'An attempt was made to operate on a modal dialog when one was not open')
        : { value: this.alert };
    }

    if (route === 'POST /execute/sync') {
      const script = (call.body as { script?: unknown } | undefined)?.script;
      if (script === 'mobile: activeAppInfo') {
        return { value: { pid: 48213, bundleId: this.activeBundleId, name: 'Acme', processArguments: {} } };
      }
      return { value: null };
    }
    if (route === 'POST /elements') {
      const { using, value } = (call.body ?? {}) as { using?: unknown; value?: unknown };
      if (using !== 'xpath' || typeof value !== 'string') {
        return w3cError(400, 'invalid argument', 'only xpath is served by the fake');
      }
      try {
        const found = evaluatePath(this.source, value);
        return { value: found.map(() => ({ [ELEMENT_KEY]: `el-${(this.#elements += 1)}` })) };
      } catch (error) {
        return w3cError(400, 'invalid selector', (error as Error).message);
      }
    }
    if (route === 'GET /element/active') return { value: { [ELEMENT_KEY]: 'el-active' } };
    if (/^POST \/element\/[^/]+\/(click|clear|value)$/.test(route)) return { value: null };

    return w3cError(404, 'unknown command', `The requested resource could not be found: ${route}`);
  }
}
