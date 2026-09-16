import { Pane } from 'tweakpane';
import {
  createDefaultConfig,
  createParameterRegistry,
  getPath,
  setPath,
} from './experiment-config.js';
import {
  getLanguage,
  t,
  toggleLanguage,
  translateOptions,
} from './experiment-i18n.js';
import { VISUAL_LAYERS } from './school-visualizer.js';

const VISUAL_LAYER_LABELS = {
  reynolds: 'Reynolds radii',
  walls: 'avoidance ray',
  fieldOfView: 'blind cone (field of view)',
  hunting: 'hunting radii + target',
  panic: 'threat + signal radii',
};

function niceRangeNumber(value) {
  return Number.parseFloat(value.toPrecision(8));
}

export function zoomRangeWindow(state, value, factor, limits) {
  const hardWidth = limits.max - limits.min;
  const minimumWidth = Math.min(
    hardWidth,
    Math.max(limits.step * 2, Number.EPSILON)
  );
  const width = Math.max(
    minimumWidth,
    Math.min(hardWidth, (state.max - state.min) * factor)
  );
  let min = value - width / 2;
  let max = value + width / 2;
  if (min < limits.min) {
    max += limits.min - min;
    min = limits.min;
  }
  if (max > limits.max) {
    min -= max - limits.max;
    max = limits.max;
  }
  min = Math.max(limits.min, min);
  max = Math.min(limits.max, max);
  const precisionStep =
    limits.step === 1
      ? 1
      : Math.min(
          limits.step,
          10 ** Math.floor(Math.log10(Math.max(width, Number.EPSILON) / 100))
        );
  return {
    min: niceRangeNumber(min),
    max: niceRangeNumber(max),
    step: niceRangeNumber(precisionStep),
  };
}

// ⚠️ 这里的【键顺序就是标签页顺序】——下面用 Object.entries(PROJECTS) 渲染。
// 调整顺序请直接调整条目位置，不要另加排序数组。
const PROJECTS = {
  aquarium: {
    eyebrow: 'MAIN PROJECT',
    title: 'Aquarium',
    description: 'Size decides predator and prey in real time; energy and plankton are on, starvation is permanent.',
    dashboard: 'LIVE FOOD WEB',
  },
  ecology: {
    eyebrow: 'SUB-EXPERIMENT 02',
    title: 'Ecology run',
    description: 'Depletable plankton, real hunger and two-layer predation; ends when one population remains.',
    dashboard: 'ECOLOGY LEDGER',
  },
};

export const SCHOOL_SECTIONS = [
  {
    title: '身份与形态',
    expanded: true,
    fields: ['id', 'name', 'color', 'count', 'size'],
  },
  {
    title: '运动',
    expanded: true,
    fields: ['cruiseSpeed', 'maxSpeed', 'turnSpeed'],
  },
  {
    title: '生态角色',
    expanded: false,
    fields: ['grazeRate'],
  },
  {
    title: '分离 · Separation',
    expanded: false,
    fields: ['separationWeight'],
    derivedRadius: 'separationRadius',
    globalPaths: ['perception.separationRadiusFactor'],
  },
  {
    title: '对齐 · Alignment',
    expanded: false,
    fields: ['alignmentWeight'],
    derivedRadius: 'alignmentRadius',
    globalPaths: ['perception.alignmentRadiusFactor'],
  },
  {
    title: '凝聚 · Cohesion',
    expanded: false,
    fields: ['targetNeighbors', 'cohesionWeight'],
    derivedRadius: 'cohesionRadius',
  },
  {
    title: '出生布局',
    expanded: false,
    fields: ['spawnRegion', 'initialHeading'],
  },
];

export const SCHOOL_EMBEDDED_GLOBAL_PATHS = new Set(
  SCHOOL_SECTIONS.flatMap((section) => section.globalPaths ?? [])
);

const MAP_GROUPS = new Set([
  '障碍距离场',
  'Advanced · Distance Field',
  '障碍',
  'Advanced · Physics Spawn',
]);
const ECOLOGY_GROUPS = new Set([
  'Trait Coupling',
  '生态能量',
  '浮游资源',
]);
const CAPTURE_GROUPS = new Set(['捕食', '捕获特效']);

function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

const inChinese = () => getLanguage() === 'zh';

function relationGlyph(relation) {
  return (
    inChinese()
      ? { pursuit: '追', evade: '逃', peer: '同', ignore: '·' }
      : { pursuit: 'P', evade: 'E', peer: '=', ignore: '·' }
  )[relation];
}

function relationLabel(relation) {
  return (
    inChinese()
      ? { pursuit: '捕食', evade: '逃逸', peer: '同级', ignore: '忽略' }
      : { pursuit: 'hunts', evade: 'flees', peer: 'peer', ignore: 'ignores' }
  )[relation];
}

function roleLabel(relations = []) {
  const pursuit = relations.includes('pursuit');
  const evade = relations.includes('evade');
  const zh = inChinese();
  if (pursuit && evade) return zh ? '双重角色：捕食者 + 被捕食者' : 'predator and prey';
  if (pursuit) return zh ? '捕食者' : 'predator';
  if (evade) return zh ? '被捕食者' : 'prey';
  return zh ? '同级群体' : 'peer';
}

function groupVisible(project, group) {
  if (MAP_GROUPS.has(group) || group.startsWith('障碍 ·')) {
    // Obstacle controls belong to a later tier that is not in this build.
    return false;
  }
  if (ECOLOGY_GROUPS.has(group)) {
    return project === 'aquarium' || project === 'ecology';
  }
  if (CAPTURE_GROUPS.has(group)) return true;
  return group !== '项目';
}

export function createExperimentDebug({
  controller,
  simulation,
}) {
  let pane = null;
  let selectedSchoolIndex = 0;
  let roleState = null;
  let roleBindings = [];
  let boidState = null;
  let boidBindings = [];
  const rangeWindows = new Map();
  const defaultConfig = createDefaultConfig();
  const holder = document.getElementById('panel-holder');
  const dashboard = document.createElement('section');
  dashboard.id = 'experiment-dashboard';
  dashboard.setAttribute('aria-label', 'Live school relations and metrics');
  dashboard.innerHTML = `
    <header>
      <span id="dashboard-kind">LIVE FOOD WEB</span>
      <strong id="probe-state" aria-live="polite">running</strong>
    </header>
    <pre id="experiment-metrics">…</pre>
  `;
  document.getElementById('app').appendChild(dashboard);
  const dashboardKind = dashboard.querySelector('#dashboard-kind');
  const stateLabel = dashboard.querySelector('#probe-state');
  const metricsText = dashboard.querySelector('#experiment-metrics');
  let lastUpdate = 0;

  function projectMeta() {
    return (
      PROJECTS[controller.stage.runtime.project] ?? PROJECTS.aquarium
    );
  }

  function switchProject(project) {
    if (project === controller.stage.runtime.project) return;
    controller.stage.runtime.project = project;
    controller.applyConfig('rebuildScene', 'runtime.project');
    selectedSchoolIndex = Math.min(
      selectedSchoolIndex,
      controller.stage.schools.length - 1
    );
    rebuildPane();
  }

  function addProjectSwitcher() {
    const current = controller.stage.runtime.project;
    const meta = projectMeta();
    const switcher = document.createElement('section');
    switcher.id = 'project-switcher';
    switcher.innerHTML = `
      <header>
        <span>${meta.eyebrow}</span>
        <strong>${meta.title}</strong>
      </header>
      <div class="project-tabs" role="tablist" aria-label="Projects">
        ${Object.entries(PROJECTS)
          .map(
            ([id, item]) => `
              <button
                type="button"
                role="tab"
                data-project="${id}"
                aria-selected="${id === current}"
              >${item.title}</button>
            `
          )
          .join('')}
      </div>
      <p>${meta.description}</p>
    `;
    for (const button of switcher.querySelectorAll('[data-project]')) {
      button.addEventListener('click', () => {
        switchProject(button.dataset.project);
      });
    }
    holder.appendChild(switcher);
  }

  // 语言只是显示层的事，不进 config —— 所以它不受「重置本场」
  // 和「恢复默认值」影响，切换后重建面板就够了。
  function addLanguageToggle(root) {
    const title =
      getLanguage() === 'en' ? 'Language · English → 中文' : '语言 · 中文 → English';
    root.addButton({ title }).on('click', () => {
      toggleLanguage();
      rebuildPane();
    });
  }

  function addActionButtons(root) {
    const project = controller.stage.runtime.project;
    const run = root.addFolder({
      title: t(
        project === 'aquarium'
          ? '主项目操作'
          : project === 'ecology'
            ? '生态实验操作'
            : '子实验操作'
      ),
      expanded: true,
    });
    run.addButton({ title: t('reset current project') }).on('click', () => {
      controller.reset();
    });
  }

  function addConfigButtons(root) {
    const actions = root.addFolder({ title: t('配置文件'), expanded: false });
    actions.addButton({ title: t('恢复默认值') }).on('click', () => {
      controller.restoreDefaults();
      rangeWindows.clear();
      selectedSchoolIndex = 0;
      rebuildPane();
    });
    actions.addButton({ title: t('导出 JSON') }).on('click', () => {
      downloadText(
        `experiment-${controller.stage.runtime.seed}.json`,
        controller.exportConfig()
      );
    });
    actions.addButton({ title: t('导入 JSON') }).on('click', () => {
      const text = window.prompt(
        inChinese() ? '粘贴完整 ExperimentConfig JSON' : 'Paste a complete ExperimentConfig JSON'
      );
      if (!text) return;
      try {
        controller.importConfig(text);
        rangeWindows.clear();
        selectedSchoolIndex = 0;
        rebuildPane();
      } catch (error) {
        window.alert(error.message);
      }
    });
    actions.addButton({ title: t('保存到浏览器') }).on('click', () => {
      localStorage.setItem(
        'experiment-config-v2',
        controller.exportConfig()
      );
    });
    actions.addButton({ title: t('读取浏览器配置') }).on('click', () => {
      const text = localStorage.getItem('experiment-config-v2');
      if (!text) return;
      controller.importConfig(text);
      rangeWindows.clear();
      selectedSchoolIndex = 0;
      rebuildPane();
    });
    actions.addButton({ title: t('复制 seed') }).on('click', () => {
      navigator.clipboard?.writeText(String(controller.stage.runtime.seed));
    });
    actions.addButton({ title: t('导出实验报告') }).on('click', () => {
      downloadText(
        `experiment-report-${controller.stage.runtime.seed}.json`,
        JSON.stringify(simulation.metrics(), null, 2)
      );
    });
  }

  function bindSpec(folder, spec) {
    const keys = spec.path.split('.');
    const key = keys.pop();
    const parent = keys.reduce(
      (value, part) => value[part],
      controller.stage
    );
    const isNumeric =
      typeof parent[key] === 'number' &&
      spec.min !== undefined &&
      !spec.options;
    const initialRange = isNumeric
      ? { min: spec.min, max: spec.max, step: spec.step }
      : null;
    let range = isNumeric
      ? { ...(rangeWindows.get(spec.path) ?? initialRange) }
      : null;
    if (
      isNumeric &&
      (parent[key] < range.min || parent[key] > range.max)
    ) {
      range = { ...initialRange };
      rangeWindows.delete(spec.path);
    }
    const configuredDefault = getPath(defaultConfig, spec.path);
    const defaultValue =
      configuredDefault === undefined ? parent[key] : configuredDefault;
    let binding = null;

    function bindingOptions(index) {
      const options = { label: t(spec.label) };
      if (isNumeric) {
        options.min = range.min;
        options.max = range.max;
        options.step = range.step;
      }
      if (spec.options) options.options = translateOptions(spec.options);
      if (index !== undefined && index >= 0) options.index = index;
      return options;
    }

    function applyChange(event) {
      if (spec.applyMode !== 'live' && !event.last) return;
      try {
        controller.applyConfig(spec.applyMode, spec.path);
        if (
          spec.path === 'tank.preset' ||
          spec.path === 'runtime.populationPreset'
        ) {
          setTimeout(rebuildPane, 0);
        } else if (
          spec.path.endsWith('.name') ||
          spec.path.endsWith('.id') ||
          spec.path.endsWith('.count')
        ) {
          setTimeout(rebuildPane, 0);
        }
      } catch (error) {
        setPath(
          controller.stage,
          spec.path,
          getPath(controller.current, spec.path)
        );
        window.alert(error.message);
        if (
          isNumeric &&
          (parent[key] < range.min || parent[key] > range.max)
        ) {
          range = { ...initialRange };
          rangeWindows.delete(spec.path);
          rebuildBinding();
        } else {
          binding.refresh();
        }
      }
    }

    function addLabelButton(label, text, title, action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'param-btn';
      button.textContent = text;
      button.title = title;
      button.setAttribute('aria-label', title);
      button.addEventListener('pointerdown', (event) => {
        event.stopPropagation();
      });
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        action();
      });
      label.appendChild(button);
    }

    function decorate() {
      const label = binding.element.querySelector('.tp-lblv_l');
      if (!label) return;
      const zh = inChinese();
      label.title = isNumeric
        ? zh
          ? `当前量程 ${range.min}–${range.max} · 安全范围 ${spec.min}–${spec.max} · 默认 ${defaultValue}`
          : `range ${range.min}–${range.max} · safe ${spec.min}–${spec.max} · default ${defaultValue}`
        : zh
          ? `默认 ${defaultValue}`
          : `default ${defaultValue}`;
      addLabelButton(
        label,
        '↺',
        zh
          ? `恢复默认值 ${defaultValue} 和完整量程`
          : `Reset to default ${defaultValue} and full range`,
        resetParameter
      );
      if (!isNumeric) return;
      addLabelButton(label, '+', zh ? '缩小量程，以当前值为中心' : 'Narrow the range around the current value', () =>
        zoom(0.5)
      );
      addLabelButton(label, '−', zh ? '扩大量程，以当前值为中心' : 'Widen the range around the current value', () =>
        zoom(2)
      );
    }

    function attach() {
      binding.on('change', applyChange);
      decorate();
      if (isNewSpec(spec)) markNew(binding.element);
    }

    function rebuildBinding() {
      const index = folder.children.indexOf(binding);
      binding?.dispose();
      binding = folder.addBinding(parent, key, bindingOptions(index));
      attach();
    }

    function zoom(factor) {
      range = zoomRangeWindow(range, parent[key], factor, {
        min: spec.min,
        max: spec.max,
        step: spec.step,
      });
      rangeWindows.set(spec.path, range);
      rebuildBinding();
    }

    function resetParameter() {
      parent[key] = defaultValue;
      if (isNumeric) {
        range = { ...initialRange };
        rangeWindows.delete(spec.path);
        rebuildBinding();
      } else {
        binding.refresh();
      }
      applyChange({ value: parent[key], last: true });
    }

    binding = folder.addBinding(parent, key, bindingOptions());
    attach();
    return binding;
  }

  function addSchoolEditor(root, registry) {
    selectedSchoolIndex = Math.max(
      0,
      Math.min(
        selectedSchoolIndex,
        controller.stage.schools.length - 1
      )
    );
    const schools = controller.stage.schools;
    const school = schools[selectedSchoolIndex];
    const editor = root.addFolder({
      title: `${t('鱼群')} ${selectedSchoolIndex + 1}/${schools.length} · ${school.name}`,
      expanded: true,
    });
    if (schools.length > 1) {
      editor
        .addButton({ title: t('← 上一个鱼群') })
        .on('click', () => {
          selectedSchoolIndex =
            (selectedSchoolIndex - 1 + schools.length) % schools.length;
          rebuildPane();
        });
      editor
        .addButton({ title: t('下一个鱼群 →') })
        .on('click', () => {
          selectedSchoolIndex =
            (selectedSchoolIndex + 1) % schools.length;
          rebuildPane();
        });
    }
    if (controller.panelScope?.allowSchoolEditing ?? true) {
      const addButton = editor.addButton({ title: t('+ 新增鱼群（复制当前）') });
      addButton.on('click', () => {
        controller.addSchool(selectedSchoolIndex);
        selectedSchoolIndex = controller.stage.schools.length - 1;
        rebuildPane();
      });
      const removeButton = editor.addButton({ title: t('− 删除当前鱼群') });
      removeButton.on('click', () => {
        try {
          controller.removeSchool(selectedSchoolIndex);
          selectedSchoolIndex = Math.min(
            selectedSchoolIndex,
            controller.stage.schools.length - 1
          );
          rebuildPane();
        } catch (error) {
          window.alert(error.message);
        }
      });
      if (controller.panelScope?.isNewSchoolEditing) {
        markNew(addButton.element);
        markNew(removeButton.element);
      }
    }

    roleState = {
      role: t('计算中…'),
      relations: '—',
      derived: '—',
    };
    // Roles only mean something when there is someone to hunt or flee.
    const showRoles =
      schools.length > 1 && controller.stage.relations.enabled !== false;
    roleBindings = !showRoles ? [] : [
      editor.addBinding(roleState, 'role', {
        label: t('体型自动角色'),
        readonly: true,
      }),
      editor.addBinding(roleState, 'relations', {
        label: t('对其他鱼群'),
        readonly: true,
      }),
      editor.addBinding(roleState, 'derived', {
        label: t('派生感知'),
        readonly: true,
      }),
    ];
    boidState = {
      separationRadius: '—',
      alignmentRadius: '—',
      cohesionRadius: '—',
    };
    boidBindings = [];

    const prefix = `schools.${selectedSchoolIndex}.`;
    const specs = registry.filter((spec) => spec.path.startsWith(prefix));
    for (const section of SCHOOL_SECTIONS) {
      const sectionSpecs = specs.filter((spec) => {
        const relative = spec.path.slice(prefix.length);
        return section.fields.some(
          (field) =>
            (relative === field || relative.startsWith(`${field}.`)) &&
            schoolFieldVisible(field)
        );
      });
      if (
        sectionSpecs.length === 0 &&
        !section.derivedRadius &&
        !section.globalPaths?.length
      ) {
        continue;
      }
      const folder = editor.addFolder({
        title: t(section.title),
        expanded: section.expanded,
      });
      if (section.derivedRadius) {
        boidBindings.push(
          folder.addBinding(boidState, section.derivedRadius, {
            label: t('actual radius'),
            readonly: true,
          })
        );
      }
      if (!section.globalAfterFields) {
        for (const path of section.globalPaths ?? []) {
          const globalSpec = registry.find((spec) => spec.path === path);
          if (globalSpec) bindSpec(folder, globalSpec);
        }
      }
      for (const spec of sectionSpecs) bindSpec(folder, spec);
      if (section.globalAfterFields) {
        for (const path of section.globalPaths ?? []) {
          const globalSpec = registry.find((spec) => spec.path === path);
          if (globalSpec) bindSpec(folder, globalSpec);
        }
      }
    }
    addVisualLayers(editor, school);
  }

  // View-only toggles for this school; a tier offers only the layers whose
  // rules it has introduced.
  function addVisualLayers(editor, school) {
    if (!controller.visualLayersFor) return;
    const layers = controller.visualLayersFor(school);
    const offered = VISUAL_LAYERS.filter(
      (layer) => controller.panelScope?.showVisual(layer) ?? true
    );
    if (offered.length === 0) return;
    const folder = editor.addFolder({ title: t('可视化'), expanded: true });
    for (const layer of offered) {
      const binding = folder.addBinding(layers, layer, {
        label: t(VISUAL_LAYER_LABELS[layer]),
      });
      if (controller.panelScope?.isNewVisual?.(layer)) markNew(binding.element);
    }
  }

  // Highlight what this tier adds over the tier before it. The enclosing
  // folders get a marker too, so a new parameter inside a collapsed folder
  // is still visible.
  function markNew(element) {
    element.classList.add('is-new');
    for (let node = element.parentElement; node; node = node.parentElement) {
      if (node.classList.contains('tp-fldv')) node.classList.add('has-new');
      if (node === holder) break;
    }
  }

  function isNewSpec(spec) {
    const scope = controller.panelScope;
    if (!scope?.isNewGlobal) return false;
    const match = /^schools\.\d+\.([^.]+)/.exec(spec.path);
    return match ? scope.isNewSchoolField(match[1]) : scope.isNewGlobal(spec);
  }

  // A research tier can narrow the panel to the parameters it introduces.
  // Without a scope the panel falls back to the per-project rules.
  function globalVisible(project, spec) {
    const scope = controller.panelScope;
    return scope ? scope.showGlobal(spec) : groupVisible(project, spec.group);
  }

  function schoolFieldVisible(field) {
    return controller.panelScope?.showSchoolField(field) ?? true;
  }

  function addGlobalParameters(root, registry) {
    const project = controller.stage.runtime.project;
    const folders = new Map();
    for (const spec of registry) {
      if (
        spec.path.startsWith('schools.') ||
        spec.path === 'runtime.project' ||
        SCHOOL_EMBEDDED_GLOBAL_PATHS.has(spec.path) ||
        !globalVisible(project, spec)
      ) {
        continue;
      }
      let folder = folders.get(spec.group);
      if (!folder) {
        folder = root.addFolder({
          title: t(spec.group),
          expanded:
            !spec.group.startsWith('Advanced') &&
            ['运行', '关系'].includes(spec.group),
        });
        folders.set(spec.group, folder);
      }
      bindSpec(folder, spec);
    }
  }

  function rebuildPane() {
    // Structural changes intentionally destroy the whole pane. The project
    // switcher and selected-school editor therefore cannot retain listeners.
    pane?.dispose();
    holder.replaceChildren();
    const scope = controller.panelScope;
    if (!scope) addProjectSwitcher();
    const meta = projectMeta();
    pane = new Pane({
      title: `${scope?.eyebrow ?? meta.eyebrow} · ${t('参数')}`,
      container: holder,
    });
    addLanguageToggle(pane);
    addActionButtons(pane);
    const registry = createParameterRegistry(controller.stage);
    addSchoolEditor(pane, registry);
    addGlobalParameters(pane, registry);
    addConfigButtons(pane);
  }

  function updateSelectedSchool(metrics) {
    const school = metrics.population[selectedSchoolIndex];
    const row = metrics.relationMatrix[selectedSchoolIndex];
    if (!school || !row || !roleState) return;
    roleState.role = roleLabel(row);
    roleState.relations = row
      .map((relation, index) => {
        if (index === selectedSchoolIndex) return null;
        return `${metrics.population[index].name}:${relationLabel(relation)}`;
      })
      .filter(Boolean)
      .join(' · ');
    roleState.derived =
      `size ${school.size.toFixed(2)} · hunt/panic ${school.detectionLength.toFixed(3)} · burst ${school.burstRadius.toFixed(3)}`;
    boidState.separationRadius =
      school.separationRadius.toFixed(3);
    boidState.alignmentRadius =
      school.alignmentRadius.toFixed(3);
    boidState.cohesionRadius =
      school.cohesionRadius.toFixed(3);
    for (const binding of roleBindings) binding.refresh();
    for (const binding of boidBindings) binding.refresh();
  }

  function update(nowMs) {
    if (nowMs - lastUpdate < 120) return;
    lastUpdate = nowMs;
    const metrics = simulation.metrics();
    const meta = PROJECTS[metrics.project] ?? PROJECTS.aquarium;
    dashboard.dataset.project = metrics.project;
    dashboardKind.textContent = meta.dashboard;
    if (!controller.panelScope) {
      document.getElementById('lab-title').textContent = meta.title;
      document.getElementById('lab-subtitle').textContent =
        `${meta.eyebrow} · Three.js`;
    }
    let stateText = 'running';
    if (metrics.project === 'aquarium') {
      stateText = 'LIVE · SIZE ROLES';
    } else if (metrics.project === 'ecology') {
      stateText =
        metrics.ecology.state === 'winner'
          ? `WIN · ${metrics.ecology.winnerName}`
          : metrics.ecology.state === 'collapse'
            ? 'COLLAPSE · NO WINNER'
            : 'LIVE · ENERGY';
    }
    stateLabel.textContent = stateText;
    updateSelectedSchool(metrics);
    const matrix = metrics.relationMatrix
      .map(
        (row, index) =>
          `${metrics.population[index].name.padEnd(4, ' ')} ${row
            .map(relationGlyph)
            .join('  ')}`
      )
      .join('\n');
    const ecologyOn = controller.current.ecology.enabled !== false;
    const predationOn = controller.current.relations.enabled !== false;
    const population = metrics.population
      .map((item) => {
        const ecology = ecologyOn
          ? ` E=${(item.averageEnergy * 100).toFixed(0)}% dead=${item.deaths.captured}/${item.deaths.starved}`
          : predationOn
            ? ` eaten=${item.deaths.captured}`
            : '';
        return `${item.name} ${item.alive}/${item.target} size=${item.size.toFixed(2)} r=${item.neighborRadius.toFixed(3)}${ecology}`;
      })
      .join('\n');
    const capture = metrics.predatorPairs
      .map((pair) => {
        const closure = Number.isFinite(pair.nominalClosureSeconds)
          ? `${pair.nominalClosureSeconds.toFixed(2)}s`
          : '∞';
        return `${pair.actor}→${pair.target} cap=${pair.captures}/${pair.chaseStarts} ${(pair.conversion * 100).toFixed(1)}% chase=${pair.averageChaseSeconds.toFixed(2)}s close=${closure}`;
      })
      .join('\n');
    const relationsTitle = inChinese()
      ? '体型派生关系（行作用于列）'
      : 'Relations by size (row acts on column) · P hunts · E flees · = peer';
    metricsText.textContent =
      `${population}\n\n${relationsTitle}\n${matrix}` +
      `${capture ? `\n${capture}` : ''}` +
      `${
        ecologyOn
          ? `

carrion=${metrics.ecology.plankton.level.toFixed(0)} eaten=${metrics.ecology.plankton.consumed.toFixed(0)}` +
            (metrics.project === 'ecology'
              ? `
outcome=${metrics.ecology.state}${metrics.ecology.winnerName ? ` winner=${metrics.ecology.winnerName}` : ''}`
              : '')
          : ''
      }` +
      `\npairs=${metrics.pairCount} sim=${metrics.simulationMs.toFixed(1)}ms render=${metrics.renderFps.toFixed(0)}fps` +
      `\ncaptures=${metrics.captures} fx=${metrics.captureParticles} deaths=permanent` +
      `${metrics.warnings.length ? `\nwarning: ${metrics.warnings.join(' · ')}` : ''}`;
  }

  rebuildPane();
  return {
    update,
    rebuildPane,
    dispose() {
      pane?.dispose();
      dashboard.remove();
    },
    get pane() {
      return pane;
    },
  };
}
