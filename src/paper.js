/**
 * Renders a tier's text into the paper column (index.html #paper).
 *
 * Formula symbols carry `data-param` (see sym() in tier-text.js). A symbol of
 * a mechanism this tier introduces takes the mechanism's color; symbols from
 * earlier tiers stay in ink but are still clickable.
 */
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { MECHANISMS, mechanismFor } from './mechanisms.js';
import { TIER_TEXT } from './tier-text.js';

const KATEX_OPTIONS = {
  displayMode: true,
  throwOnError: false,
  strict: 'ignore',
  // Only the data attribute that links a symbol to its slider.
  trust: ({ command }) => command === '\\htmlData',
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderFormula(tex, tierNumber) {
  const node = element('div', 'formula');
  katex.render(tex, node, KATEX_OPTIONS);
  for (const symbol of node.querySelectorAll('[data-param]')) {
    const mechanism = mechanismFor(symbol.dataset.param);
    if (mechanism && MECHANISMS[mechanism].tier === tierNumber) {
      symbol.style.color = MECHANISMS[mechanism].color;
    }
  }
  return node;
}

function renderModel(model, tierNumber) {
  const fragment = document.createDocumentFragment();
  fragment.append(element('h2', '', 'The model'));
  if (model.draft) fragment.append(element('p', 'draft-note', model.draft));
  for (const section of model.sections) {
    fragment.append(element('h3', '', section.title));
    for (const paragraph of section.text ?? []) {
      fragment.append(element('p', '', paragraph));
    }
    for (const tex of section.formulas ?? []) {
      fragment.append(renderFormula(tex, tierNumber));
    }
    if (section.note) fragment.append(element('p', 'note', section.note));
    if (section.list) {
      const list = element('ul');
      for (const item of section.list) list.append(element('li', '', item));
      fragment.append(list);
    }
  }
  return fragment;
}

export function renderPaper(container, tier, tierCount, { onParameter } = {}) {
  const text = TIER_TEXT[tier.number] ?? {};
  container.replaceChildren();
  container.append(
    element('p', 'eyebrow', `Tier ${tier.number} of ${tierCount}`),
    element('h1', '', tier.title),
    element('h2', '', 'What is added'),
    element('p', 'added', text.added ?? '')
  );
  container.append(element('h2', '', 'Why'));
  if (text.why?.length) {
    for (const paragraph of text.why) container.append(element('p', '', paragraph));
  } else {
    container.append(element('p', 'placeholder', 'Not written yet.'));
  }
  container.append(
    element('h2', '', 'Watch for'),
    element('p', 'watch', text.watch ?? '')
  );
  if (text.model) container.append(renderModel(text.model, tier.number));
  container.scrollTop = 0;

  container.onclick = (event) => {
    const symbol = event.target.closest('[data-param]');
    if (!symbol || !container.contains(symbol)) return;
    onParameter?.(symbol.dataset.param);
  };
}
