/**
 * Un analyseur XML minimal, sans dépendance.
 *
 * Il ne couvre que ce que produit la source de page XCUITest : des éléments,
 * des attributs entre guillemets, des entités. Le texte entre balises est
 * ignoré — WebDriverAgent ne met rien d'utile hors des attributs. Ajouter une
 * dépendance d'exécution pour ça violerait la règle du paquet (playwright et
 * yaml, rien d'autre), et ce sous-ensemble tient en une page.
 */

export interface XmlElement {
  tag: string;
  attributes: Record<string, string>;
  children: XmlElement[];
}

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Décode les entités nommées et numériques.
 *
 * Une entité inconnue ou un point de code invalide est laissé tel quel :
 * deviner produirait un libellé que l'application n'affiche pas, donc une
 * cible introuvable — mieux vaut le texte brut, lisible dans un rapport.
 */
export function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      // XML n'admet que « &#x » en minuscule ; « &#X » n'est pas une entité.
      const code = body[1] === 'x'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return whole;
      if (code >= 0xd800 && code <= 0xdfff) return whole;
      return String.fromCodePoint(code);
    }
    return NAMED[body] ?? whole;
  });
}

/**
 * L'erreur ne recopie jamais le document : une source de page contient la
 * valeur des champs saisis, et ce message peut finir dans un journal de CI.
 * L'offset suffit à retrouver le défaut dans une capture locale.
 */
export class XmlError extends Error {
  constructor(message: string, offset: number) {
    super(`malformed page source at offset ${offset}: ${message}`);
    this.name = 'XmlError';
  }
}

const NAME = /[^\s=/>"'<]+/y;
const SPACE = /\s*/y;

export function parseXml(source: string): XmlElement {
  let at = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;

  const skipSpace = (): void => {
    SPACE.lastIndex = at;
    SPACE.exec(source);
    at = SPACE.lastIndex;
  };

  const readName = (): string => {
    NAME.lastIndex = at;
    const found = NAME.exec(source);
    if (found === null) throw new XmlError('name expected', at);
    at = NAME.lastIndex;
    return found[0];
  };

  const skipUntil = (marker: string, what: string): void => {
    const end = source.indexOf(marker, at);
    if (end < 0) throw new XmlError(`unterminated ${what}`, at);
    at = end + marker.length;
  };

  while (at < source.length) {
    const open = source.indexOf('<', at);
    if (open < 0) break;
    at = open;

    if (source.startsWith('<?', at)) {
      skipUntil('?>', 'declaration');
      continue;
    }
    if (source.startsWith('<!--', at)) {
      skipUntil('-->', 'comment');
      continue;
    }
    if (source.startsWith('<![CDATA[', at)) {
      skipUntil(']]>', 'CDATA section');
      continue;
    }
    if (source.startsWith('<!', at)) {
      skipUntil('>', 'doctype');
      continue;
    }

    if (source.startsWith('</', at)) {
      at += 2;
      const tag = readName();
      skipSpace();
      if (source[at] !== '>') throw new XmlError(`">" expected after </${tag}`, at);
      at += 1;
      const current = stack.pop();
      if (current === undefined || current.tag !== tag) {
        throw new XmlError(`unexpected closing tag </${tag}>`, at);
      }
      continue;
    }

    at += 1;
    const element: XmlElement = { tag: readName(), attributes: {}, children: [] };

    for (;;) {
      skipSpace();
      const next = source[at];
      if (next === undefined) throw new XmlError(`unterminated tag <${element.tag}>`, at);
      if (next === '>' || next === '/') break;
      const name = readName();
      skipSpace();
      if (source[at] !== '=') throw new XmlError(`"=" expected after attribute ${name}`, at);
      at += 1;
      skipSpace();
      const quote = source[at];
      if (quote !== '"' && quote !== "'") throw new XmlError(`quoted value expected for ${name}`, at);
      const end = source.indexOf(quote, at + 1);
      if (end < 0) throw new XmlError(`unterminated value for ${name}`, at);
      element.attributes[name] = decodeEntities(source.slice(at + 1, end));
      at = end + 1;
    }

    const selfClosing = source[at] === '/';
    if (selfClosing) {
      at += 1;
      if (source[at] !== '>') throw new XmlError(`">" expected after "/"`, at);
    }
    at += 1;

    const parent = stack[stack.length - 1];
    if (parent !== undefined) parent.children.push(element);
    else if (root === null) root = element;
    else throw new XmlError('several root elements', at);

    if (!selfClosing) stack.push(element);
  }

  if (stack.length > 0) {
    throw new XmlError(`unclosed element <${(stack[stack.length - 1] as XmlElement).tag}>`, at);
  }
  if (root === null) throw new XmlError('no element found', 0);
  return root;
}
