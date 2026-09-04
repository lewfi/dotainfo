import assert from 'node:assert/strict';
import test from 'node:test';

import { createSearchIndex, SEARCH_INDEX_VERSION } from '../src/presentation/search.mjs';

function fixtures() {
  return {
    teams: [
      { teamId: 10, name: { display: 'Shared' }, tag: 'TAG', titleStem: 'Shared (2024)', matchCount: 9 },
      { teamId: 11, name: { display: 'Shared' }, tag: null, titleStem: 'Shared (11)', matchCount: 2 },
    ],
    tournaments: [
      { leagueId: 20, name: 'League', titleStem: 'League', matchCount: 7 },
    ],
    heroes: [
      { heroId: 30, name: 'Hero Name', pickCount: 4, banCount: 3 },
    ],
  };
}

test('search index is compact columnar data with parallel arrays', () => {
  const index = createSearchIndex(fixtures());
  assert.equal(index.v, SEARCH_INDEX_VERSION);
  assert.deepEqual(index.t.i, [10, 11]);
  assert.deepEqual(index.t.n, ['Shared', 'Shared']);
  assert.deepEqual(index.t.g, ['TAG', '']);
  assert.deepEqual(index.t.w, [9, 2]);
  assert.ok(['i', 'n', 'g', 'w'].every((key) => index.t[key].length === 2));
  assert.ok(['i', 'n'].every((key) => index.l[key].length === 1));
  assert.ok(['i', 'n'].every((key) => index.h[key].length === 1));
  assert.equal(index.t.c.i.length, index.t.c.y.length);
  assert.equal(index.l.c.i.length, index.l.c.y.length);
});

test('search discriminators reproduce destination title suffixes', () => {
  const index = createSearchIndex(fixtures());
  assert.deepEqual(index.t.c, { i: [0, 1], y: [2024, 0] });
  assert.deepEqual(index.l.c, { i: [], y: [] });
  assert.equal(index.h.c, undefined);
});

test('search weights preserve team match counts without inflating other columns', () => {
  const index = createSearchIndex(fixtures());
  assert.deepEqual(index.t.w, [9, 2]);
  assert.equal(index.l.w, undefined);
  assert.equal(index.h.w, undefined);
});

test('search index rejects non-integer destination ids', () => {
  const data = fixtures();
  data.teams[0].teamId = '10';
  assert.throws(() => createSearchIndex(data), /ids must be safe integers/);
});
