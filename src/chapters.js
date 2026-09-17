/**
 * The site's pages in reading order: an overview before the tiers, the six
 * tiers, an outlook after them, and last a page on one possible application.
 * The overview and the outlook run the full ecosystem (the last tier's
 * configuration) with no parameter panel; they are for reading, not tuning.
 *
 * The application page is Echo Cartography, one of the author's past projects,
 * shown as one use he has in mind for a swarm like this. It comes after the
 * outlook on purpose: placed between the tiers and the outlook it read as the
 * final stage of flocks. It lives in its own folder (echo-cartography/) with
 * its own engine, has no number of its own; `label` is what the top bar shows
 * and `href` is where it lives.
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
  {
    number: null,
    label: '★',
    title: 'Echo Cartography',
    kind: 'bonus',
    href: '/echo',
    summary: 'One application I have in mind: a swarm that maps a place by its near misses, from a past project of mine.',
  },
];

/** Where a chapter lives. */
export function chapterHref(chapter) {
  return chapter.href ?? `/tier/${chapter.number}`;
}

/** The chapter before or after `chapter` in reading order, or null. */
export function neighborChapter(chapter, step) {
  const index = CHAPTERS.indexOf(chapter);
  return index < 0 ? null : CHAPTERS[index + step] ?? null;
}

export const FIRST_CHAPTER = CHAPTERS[0].number;
export const BONUS_CHAPTER = CHAPTERS.find((chapter) => chapter.kind === 'bonus');
// The last numbered chapter (the outlook); the application page follows it.
export const LAST_CHAPTER = CHAPTERS.filter((chapter) => chapter.number !== null).at(-1).number;

export function chapterByNumber(number) {
  return CHAPTERS.find((chapter) => chapter.number === number) ?? null;
}
