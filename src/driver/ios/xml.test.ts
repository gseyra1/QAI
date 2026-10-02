import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeEntities, parseXml } from './xml.ts';

describe('page source XML parser', () => {
  it('reads nested elements and their attributes, ignoring declaration, comments and text', () => {
    const root = parseXml(
      `<?xml version="1.0" encoding="UTF-8"?>\n<!-- source -->\n<AppiumAUT>\n  text is ignored\n` +
        `  <A type="A" name='single'>\n    <B x="1"/>\n    <C/>\n  </A>\n</AppiumAUT>\n<!-- trailing -->`,
    );

    assert.equal(root.tag, 'AppiumAUT');
    const a = root.children[0];
    assert.equal(a?.tag, 'A');
    assert.deepEqual(a?.attributes, { type: 'A', name: 'single' });
    assert.deepEqual(
      a?.children.map((child) => child.tag),
      ['B', 'C'],
    );
    assert.equal(a?.children[0]?.attributes['x'], '1');
  });

  it('decodes named, decimal and hexadecimal entities', () => {
    assert.equal(decodeEntities('Terms &amp; Conditions'), 'Terms & Conditions');
    assert.equal(decodeEntities('&lt;b&gt; &quot;q&quot; &apos;a&apos;'), `<b> "q" 'a'`);
    assert.equal(decodeEntities('Caf&#233; &#x2014; &#x41;'), 'Café — A');
    assert.equal(decodeEntities('line&#10;break'), 'line\nbreak');
    assert.equal(decodeEntities('&#x1F600;'), '😀');
  });

  it('leaves unknown entities and invalid code points as written', () => {
    assert.equal(decodeEntities('&nbsp; &#xD800; &#99999999; &#X41;'), '&nbsp; &#xD800; &#99999999; &#X41;');
  });

  it('decodes entities inside attribute values', () => {
    const root = parseXml('<E label="Fish &amp; Chips &#8364;5"/>');
    assert.equal(root.attributes['label'], 'Fish & Chips €5');
  });

  /**
   * Une source de page porte la valeur des champs saisis : le message
   * d'erreur ne doit jamais la recopier, il finit dans les journaux de CI.
   */
  it('rejects malformed documents without echoing their content', () => {
    const cases = [
      '<A value="hunter2-secret">',
      '<A value="hunter2-secret"></B>',
      '<A value="hunter2-secret',
      '<A value=hunter2-secret/>',
      '<A/><B value="hunter2-secret"/>',
      '',
    ];
    for (const source of cases) {
      assert.throws(
        () => parseXml(source),
        (error: Error) => /malformed page source at offset \d+/.test(error.message) && !error.message.includes('hunter2'),
        source,
      );
    }
  });
});
