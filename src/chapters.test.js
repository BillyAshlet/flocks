import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAPTERS,
  FIRST_CHAPTER,
  LAST_CHAPTER,
  chapterByNumber,
  chapterHref,
  neighborChapter,
} from './chapters.js';
import { TIER_COUNT } from './tiers.js';

test('chapters run from the overview through the tiers to the outlook, in order', () => {
  assert.deepEqual(
    CHAPTERS.filter((chapter) => chapter.kind !== 'bonus').map((chapter) => chapter.number),
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

// After the outlook, not before it: between the tiers and the outlook the
// application page read as the final stage of flocks.
test('the application page comes last, after the outlook', () => {
  const outlook = chapterByNumber(LAST_CHAPTER);
  assert.equal(neighborChapter(chapterByNumber(TIER_COUNT), 1), outlook);
  const bonus = neighborChapter(outlook, 1);
  assert.equal(bonus.kind, 'bonus');
  assert.equal(chapterHref(bonus), '/echo');
  assert.equal(neighborChapter(bonus, 1), null);
  assert.equal(neighborChapter(chapterByNumber(FIRST_CHAPTER), -1), null);
});
