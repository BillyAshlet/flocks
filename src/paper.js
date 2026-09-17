/**
 * Renders a tier's text into the paper column (index.html #paper).
 *
 * Formula symbols carry `data-param` (see sym() in tier-text.js). Every one
 * the reader can adjust is set bold on a soft highlight, so it reads as a
 * control. Clicking one opens its slider and turns that symbol, everywhere on
 * the page, into its mechanism's color, the color of the panel folder it
 * opened, until another symbol is clicked.
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
  // Static formulas render once they are in the page and can be measured.
  const pendingDisplay = [];
  const dynamicFormulas = [];
  const liveValues = [];

  let activeParam = null;
  function colorSymbols(node) {
    for (const symbol of node.querySelectorAll('[data-param]')) {
      const mechanism = mechanismFor(symbol.dataset.param);
      if (mechanism) symbol.style.setProperty('--mech-color', MECHANISMS[mechanism].color);
      symbol.classList.toggle('is-active', symbol.dataset.param === activeParam);
    }
  }

  // A display formula that does not fit the column is broken at its wide
  // gaps (\qquad) into stacked lines, and checked again whenever the column
  // changes width.
  const displayFormulas = new Map();
  function renderDisplay(node, tex) {
    displayFormulas.set(node, tex);
    renderTex(node, tex, true);
    if (!node.isConnected || node.scrollWidth <= node.clientWidth + 1) return;
    const parts = tex.split(/,?\s*\\qquad\s*/);
    if (parts.length < 2) return;
    renderTex(node, `\\begin{gathered}${parts.join('\\\\[4pt]')}\\end{gathered}`, true);
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
      pendingDisplay.push([node, source]);
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

  // Every symbol a formula group uses, named: what it is, and its value now
  // when it has one. A formula without this reads as unexplained notation.
  function whereTable(rows) {
    const table = element('table', 'where');
    const body = element('tbody');
    for (const row of rows) {
      const tr = element('tr');
      const symbol = element('td', 'where-symbol');
      renderTex(symbol, row.tex, false);
      const text = element('td', 'where-text');
      text.append(element('span', 'where-name', row.name));
      if (row.meaning) text.append(element('span', 'where-meaning', row.meaning));
      const value = element('td', 'where-value');
      if (row.value) {
        const number = element('span', 'live-value', '—');
        value.append(number);
        liveValues.push({ node: number, item: row, last: null });
      }
      tr.append(symbol, text, value);
      body.append(tr);
    }
    table.append(body);
    return table;
  }

  function renderModel(model) {
    const fragment = document.createDocumentFragment();
    fragment.append(element('h2', '', 'The model'));
    if (model.draft) fragment.append(element('p', 'draft-note', model.draft));
    for (const section of model.sections) {
      fragment.append(element('h3', '', section.title));
      for (const source of section.text ?? []) fragment.append(paragraph(source));
      for (const source of section.formulas ?? []) fragment.append(formula(source));
      if (section.where) fragment.append(whereTable(section.where));
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
  // The overview and the outlook are plain sections of prose; the tiers have
  // what is added, why, what to watch, and the model.
  const eyebrow =
    tier.kind === 'intro'
      ? 'Before the tiers'
      : tier.kind === 'outlook'
        ? 'After the tiers'
        : `Tier ${tier.number} of ${tierCount}`;
  container.append(element('p', 'eyebrow', eyebrow), element('h1', '', tier.title));
  if (text.sections) {
    for (const section of text.sections) {
      container.append(element('h2', '', section.heading));
      for (const source of section.paragraphs ?? []) container.append(element('p', '', source));
      if (section.list) {
        const list = element('ul');
        for (const item of section.list) list.append(element('li', '', item));
        container.append(list);
      }
    }
  } else {
    container.append(element('h2', '', 'What is added'), element('p', 'added', text.added ?? ''));
    container.append(element('h2', '', 'Why'));
    if (text.why?.length) {
      for (const source of text.why) container.append(element('p', '', source));
    } else {
      container.append(element('p', 'placeholder', 'Not written yet.'));
    }
    container.append(element('h2', '', 'Watch for'), element('p', 'watch', text.watch ?? ''));
  }
  if (text.model) container.append(renderModel(text.model));
  container.scrollTop = 0;
  for (const [node, tex] of pendingDisplay) renderDisplay(node, tex);
  let lastWidth = container.clientWidth;
  const resize = new ResizeObserver(() => {
    if (!container.isConnected || container.clientWidth === lastWidth) return;
    lastWidth = container.clientWidth;
    for (const [node, tex] of displayFormulas) {
      if (node.isConnected) renderDisplay(node, tex);
    }
  });
  resize.observe(container);

  container.onclick = (event) => {
    const symbol = event.target.closest('[data-param]');
    if (!symbol || !container.contains(symbol)) return;
    activeParam = symbol.dataset.param;
    colorSymbols(container);
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
        renderDisplay(entry.node, next);
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
  return {
    update,
    dispose() {
      resize.disconnect();
    },
  };
}
