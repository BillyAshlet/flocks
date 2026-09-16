/**
 * Renders a tier's text into the paper column (index.html #paper).
 *
 * Formula symbols carry `data-param` (see sym() in tier-text.js). A symbol of
 * a mechanism this tier introduces takes the mechanism's color; symbols from
 * earlier tiers stay in ink but are still clickable.
 *
 * The returned view's update() re-reads the running simulation: paragraphs and
 * formulas written as functions of the config are redrawn when they change,
 * and live values light up when they move.
 */
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { MECHANISMS, mechanismFor } from './mechanisms.js';
import { TIER_TEXT } from './tier-text.js';

const TRUST_SLIDER_LINKS = ({ command }) => command === '\\htmlData';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatValue(value, unit = '') {
  if (!Number.isFinite(value)) return '—';
  const text = Number.isInteger(value)
    ? String(value)
    : String(Number(value.toPrecision(Math.abs(value) >= 1 ? 3 : 2)));
  return `${text}${unit}`;
}

export function renderPaper(container, tier, tierCount, { onParameter, getState } = {}) {
  const text = TIER_TEXT[tier.number] ?? {};
  // Everything that depends on the running config, re-checked by update().
  const dynamicText = [];
  const dynamicFormulas = [];
  const liveValues = [];

  function colorSymbols(node) {
    for (const symbol of node.querySelectorAll('[data-param]')) {
      const mechanism = mechanismFor(symbol.dataset.param);
      if (mechanism && MECHANISMS[mechanism].tier === tier.number) {
        symbol.style.color = MECHANISMS[mechanism].color;
      }
    }
  }

  function renderTex(node, tex, displayMode) {
    katex.render(tex, node, {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      trust: TRUST_SLIDER_LINKS,
    });
    colorSymbols(node);
  }

  function paragraph(source, className = '') {
    const node = element('p', className);
    if (typeof source === 'function') {
      dynamicText.push({ node, source, last: null });
    } else {
      node.textContent = source;
    }
    return node;
  }

  function formula(source) {
    const node = element('div', 'formula');
    if (typeof source === 'function') {
      dynamicFormulas.push({ node, source, last: null });
    } else {
      renderTex(node, source, true);
    }
    return node;
  }

  function liveLine(items) {
    const line = element('div', 'live');
    line.append(element('span', 'live-label', 'Now'));
    for (const item of items) {
      const entry = element('span', 'live-item');
      const symbol = element('span', 'live-symbol');
      renderTex(symbol, item.tex, false);
      const value = element('span', 'live-value', '—');
      entry.append(symbol, element('span', 'live-equals', '='), value);
      line.append(entry);
      liveValues.push({ node: value, item, last: null });
    }
    return line;
  }

  function renderModel(model) {
    const fragment = document.createDocumentFragment();
    fragment.append(element('h2', '', 'The model'));
    if (model.draft) fragment.append(element('p', 'draft-note', model.draft));
    for (const section of model.sections) {
      fragment.append(element('h3', '', section.title));
      for (const source of section.text ?? []) fragment.append(paragraph(source));
      for (const source of section.formulas ?? []) fragment.append(formula(source));
      if (section.live) fragment.append(liveLine(section.live));
      if (section.note) fragment.append(paragraph(section.note, 'note'));
      if (section.list) {
        const list = element('ul');
        for (const item of section.list) list.append(element('li', '', item));
        fragment.append(list);
      }
    }
    return fragment;
  }

  container.replaceChildren();
  container.append(
    element('p', 'eyebrow', `Tier ${tier.number} of ${tierCount}`),
    element('h1', '', tier.title),
    element('h2', '', 'What is added'),
    element('p', 'added', text.added ?? '')
  );
  container.append(element('h2', '', 'Why'));
  if (text.why?.length) {
    for (const source of text.why) container.append(element('p', '', source));
  } else {
    container.append(element('p', 'placeholder', 'Not written yet.'));
  }
  container.append(
    element('h2', '', 'Watch for'),
    element('p', 'watch', text.watch ?? '')
  );
  if (text.model) container.append(renderModel(text.model));
  container.scrollTop = 0;

  container.onclick = (event) => {
    const symbol = event.target.closest('[data-param]');
    if (!symbol || !container.contains(symbol)) return;
    onParameter?.(symbol.dataset.param);
  };

  function update() {
    const state = getState?.();
    if (!state) return;
    for (const entry of dynamicText) {
      const next = entry.source(state.config);
      if (next !== entry.last) {
        entry.node.textContent = next;
        entry.last = next;
      }
    }
    for (const entry of dynamicFormulas) {
      const next = entry.source(state.config);
      if (next !== entry.last) {
        renderTex(entry.node, next, true);
        entry.last = next;
      }
    }
    for (const entry of liveValues) {
      let value;
      try {
        value = entry.item.value(state);
      } catch {
        value = NaN;
      }
      const next = formatValue(Number(value), entry.item.unit);
      if (next === entry.last) continue;
      entry.node.textContent = next;
      // Light up on a change, not on the first reading.
      if (entry.last !== null) {
        entry.node.classList.remove('glow');
        void entry.node.offsetWidth;
        entry.node.classList.add('glow');
      }
      entry.last = next;
    }
  }

  update();
  return { update };
}
