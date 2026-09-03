import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Scenario } from './types.ts';
import { matchesTags, parseTags } from './types.ts';

function scenario(tags?: string[]): Scenario {
  return {
    id: 't',
    title: 't',
    ...(tags !== undefined ? { tags } : {}),
    steps: [{ id: 's1', do: 'agir' }],
  };
}

describe('parseTags', () => {
  it('découpe sur la virgule et ignore le vide', () => {
    assert.deepEqual(parseTags('critical-path, paiement ,'), ['critical-path', 'paiement']);
    assert.deepEqual(parseTags(['a', 'b,c']), ['a', 'b', 'c']);
    assert.deepEqual(parseTags(undefined), []);
    assert.deepEqual(parseTags(''), []);
  });
});

/**
 * L'union, pas l'intersection : « --tags critical-path,paiement » veut dire
 * « le lot bloquant plus le paiement », ce qui correspond à l'usage réel —
 * un lot de fumée en pull request, la suite entière la nuit.
 */
describe('matchesTags', () => {
  it('ne filtre rien sans tag demandé', () => {
    assert.equal(matchesTags(scenario(), []), true);
    assert.equal(matchesTags(scenario(['lent']), []), true);
  });

  it('retient un scénario qui porte au moins un des tags', () => {
    assert.equal(matchesTags(scenario(['critical-path', 'lent']), ['critical-path']), true);
    assert.equal(matchesTags(scenario(['lent']), ['critical-path', 'lent']), true);
  });

  it('écarte un scénario sans tag quand un tag est demandé', () => {
    assert.equal(matchesTags(scenario(), ['critical-path']), false);
    assert.equal(matchesTags(scenario(['lent']), ['critical-path']), false);
  });
});
