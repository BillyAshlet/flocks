/**
 * The home page, rendered into the paper column beside the running tank:
 * what flocks is, who made it, the chapters, and the earlier projects it
 * grew out of.
 */
import { CHAPTERS } from './chapters.js';
import { TIER_TEXT } from './tier-text.js';

const AUTHOR = { name: 'Billy Ashlet', nativeName: '岳昆林', email: 'billyashlet@gmail.com' };

const EARLIER_WORK = [
  {
    title: 'The boid aquarium',
    href: 'https://boid.billyashlet.com',
    note: 'July 2026. The aquarium the fish engine started in.',
  },
  {
    title: 'Downstream',
    href: 'https://advx.billyashlet.com',
    note: 'AdventureX 2026, team project.',
  },
  {
    title: 'Echo Cartography',
    href: 'https://manycore.billyashlet.com',
    note: 'Manycore workshop, August 2026, team project.',
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
  const contact = element('p', 'home-contact');
  contact.append(mail);
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
    link.href = `/tier/${chapter.number}`;
    link.append(
      element('span', 'home-chapter-number', String(chapter.number)),
      element('span', 'home-chapter-title', chapter.title),
      element(
        'span',
        'home-chapter-summary',
        TIER_TEXT[chapter.number]?.summary ?? TIER_TEXT[chapter.number]?.added ?? ''
      )
    );
    link.addEventListener('click', (event) => {
      event.preventDefault();
      onChapter?.(chapter.number);
    });
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

  container.append(element('h2', '', 'Earlier work'));
  const earlier = element('ul', 'home-earlier');
  for (const work of EARLIER_WORK) {
    const item = element('li');
    const link = element('a', '', work.title);
    link.href = work.href;
    link.target = '_blank';
    link.rel = 'noopener';
    item.append(link, element('span', 'home-earlier-note', work.note));
    earlier.append(item);
  }
  container.append(earlier);
}
