/**
 * The home page, rendered into the paper column beside the running tank:
 * what flocks is, who made it, the chapters, and the iteration path of
 * projects it grew out of.
 */
import { CHAPTERS, chapterHref } from './chapters.js';
import { TIER_TEXT } from './tier-text.js';

const AUTHOR = {
  name: 'Billy Ashlet',
  nativeName: '岳昆林',
  email: 'billyashlet@outlook.com',
  website: 'https://www.billyashlet.com',
};

// The line of projects flocks grew out of, in the order they were made, all
// built on the same fish engine.
const ITERATION_PATH = [
  {
    title: 'The boid aquarium',
    href: 'https://boid.billyashlet.com',
    note: 'July 2026. A desktop aquarium, where the fish engine started.',
  },
  {
    title: 'Downstream',
    href: 'https://advx.billyashlet.com',
    note: 'Mid-July 2026, AdventureX, team project.',
  },
  {
    title: 'Echo Cartography',
    href: 'https://manycore.billyashlet.com',
    note: 'August 2026, Manycore workshop, team project.',
  },
  {
    title: 'flocks',
    note: 'September 2026. This site.',
  },
];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function renderHome(container, { onChapter } = {}) {
  container.replaceChildren();
  container.scrollTop = 0;

  const header = element('header', 'home-header');
  header.append(
    element('h1', 'home-title', 'flocks'),
    element(
      'p',
      'home-tagline',
      'A fish-school system grown out of Craig Reynolds’ boids, built up one rule at a time.'
    )
  );
  const byline = element('p', 'home-byline');
  byline.append(
    element('span', 'home-author', AUTHOR.name),
    element('span', 'home-author-native', AUTHOR.nativeName)
  );
  const mail = element('a', 'home-email', AUTHOR.email);
  mail.href = `mailto:${AUTHOR.email}`;
  const site = element('a', 'home-website', 'billyashlet.com');
  site.href = AUTHOR.website;
  site.target = '_blank';
  site.rel = 'noopener';
  const contact = element('p', 'home-contact');
  contact.append(mail, element('span', 'home-contact-separator', ' · '), site);
  const start = element('a', 'home-start', 'Start with the overview →');
  start.href = '/tier/0';
  start.addEventListener('click', (event) => {
    event.preventDefault();
    onChapter?.(0);
  });
  header.append(byline, contact, start);
  container.append(header);

  container.append(element('h2', '', 'Contents'));
  const contents = element('ol', 'home-contents');
  for (const chapter of CHAPTERS) {
    const item = element('li');
    const link = element('a');
    link.href = chapterHref(chapter);
    link.append(
      element('span', 'home-chapter-number', chapter.label ?? String(chapter.number)),
      element('span', 'home-chapter-title', chapter.title),
      element(
        'span',
        'home-chapter-summary',
        chapter.summary ??
          TIER_TEXT[chapter.number]?.summary ??
          TIER_TEXT[chapter.number]?.added ??
          ''
      )
    );
    // A chapter on another page (the bonus) is followed as a plain link.
    if (!chapter.href) {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        onChapter?.(chapter.number);
      });
    }
    item.append(link);
    contents.append(item);
  }
  container.append(contents);

  container.append(
    element('h2', '', 'What this is'),
    element(
      'p',
      '',
      'The rules here are my own, grown from boids and tuned by watching. What flocks shows is that local rules like these are enough to produce school-like behavior: pods, startles, hunts, die-offs. It does not claim that real fish follow these rules.'
    )
  );

  container.append(element('h2', '', 'Iteration path'));
  const earlier = element('ol', 'home-earlier');
  for (const work of ITERATION_PATH) {
    const item = element('li');
    let title;
    if (work.href) {
      title = element('a', '', work.title);
      title.href = work.href;
      title.target = '_blank';
      title.rel = 'noopener';
    } else {
      title = element('strong', '', work.title);
    }
    item.append(title, element('span', 'home-earlier-note', work.note));
    earlier.append(item);
  }
  container.append(earlier);
}
