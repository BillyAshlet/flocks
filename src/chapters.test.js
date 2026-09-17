import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAPTERS, FIRST_CHAPTER, LAST_CHAPTER, chapterByNumber } from './chapters.js';
import { TIER_COUNT } from './tiers.js';

test('chapters run from the overview through the tiers to the outlook, in order', () => {
  assert.deepEqual(
    CHAPTERS.map((chapter) => chapter.number),
    Array.from({ length: TIER_COUNT + 2 }, (_, index) => index)
  );
  assert.equal(chapterByNumber(FIRST_CHAPTER).kind, 'intro');
  assert.equal(chapterByNumber(LAST_CHAPTER).kind, 'outlook');
  for (const chapter of CHAPTERS.filter((item) => item.kind === 'tier')) {
    assert.equal(chapter.runs, chapter.number);
  }
});

test('the overview and the outlook run the full ecosystem', () => {
  assert.equal(chapterByNumber(FIRST_CHAPTER).runs, TIER_COUNT);
  assert.equal(chapterByNumber(LAST_CHAPTER).runs, TIER_COUNT);
});
