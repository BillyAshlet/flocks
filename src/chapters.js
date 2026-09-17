/**
 * The site's pages in reading order: an overview before the tiers, the six
 * tiers, a bonus page, and an outlook after them. The overview and the outlook
 * run the full ecosystem (the last tier's configuration) with no parameter
 * panel; they are for reading, not tuning.
 *
 * The bonus page is Echo Cartography, one of the author's past projects and a
 * possible use for a swarm like this. It lives in its own folder
 * (echo-cartography/) with its own engine. It has no number of its own; its
 * `label` is what the top bar shows, and `href` is where it lives.
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
  {
    number: null,
    label: '★',
    title: 'Echo Cartography',
    kind: 'bonus',
    href: '/echo',
    summary: 'Bonus: a swarm that maps a place by its near misses, from a past project of mine.',
  },
  { number: TIER_COUNT + 1, title: 'What’s next', kind: 'outlook', runs: TIER_COUNT },
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
export const LAST_CHAPTER = CHAPTERS.at(-1).number;

export function chapterByNumber(number) {
  return CHAPTERS.find((chapter) => chapter.number === number) ?? null;
}
