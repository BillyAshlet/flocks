/**
 * The site's pages in reading order: an overview before the tiers, the six
 * tiers, and an outlook after them. The overview and the outlook run the full
 * ecosystem (the last tier's configuration) with no parameter panel; they are
 * for reading, not tuning.
 */
import { TIER_COUNT, TIERS } from './tiers.js';

export const CHAPTERS = [
  { number: 0, title: 'Overview', kind: 'intro', runs: TIER_COUNT },
  ...TIERS.map((tier) => ({
    number: tier.number,
    title: tier.title,
    kind: 'tier',
    runs: tier.number,
  })),
  { number: TIER_COUNT + 1, title: 'What’s next', kind: 'outlook', runs: TIER_COUNT },
];

export const FIRST_CHAPTER = CHAPTERS[0].number;
export const LAST_CHAPTER = CHAPTERS.at(-1).number;

export function chapterByNumber(number) {
  return CHAPTERS.find((chapter) => chapter.number === number) ?? null;
}
