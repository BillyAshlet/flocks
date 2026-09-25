// The strings the page shows.
//
// flocks: the original page had a Chinese/English switch, and this fork
// dropped it -- the site is English. Why it was a switch and not bilingual
// labels is still worth knowing: written as "English first, Chinese second"
// every label doubled in length, which blew out Tweakpane's label column and
// made both languages harder to read than either alone.
//
// flocks: only the strings this page still shows are kept. The cover, the
// pitch mode, the parameter panel and the pilot mode did not come over, so
// their labels are gone with them (the original project still has them).

const DICT = {
  hudBand: 'alt',
  tpTitle: 'TERMINAL · CENTRALIZED LAYER',
  tpMap: 'POINT CLOUD · RECONSTRUCTION',
  tpCover: 'COVERAGE',
  tpFrontier: 'FRONTIER',
  tpUplink: 'UPLINK',
  tpPlan: 'plan view',
  tpFine: 'fine plan',
  tpLgUnk: 'unknown',
  tpLgFree: 'free',
  tpLgOcc: 'occupied',
  tpLgTgt: 'target',
  tpLgSwarm: 'swarm',
  tpPhase_roam: '1 free roam',
  tpPhase_plan: '2 plan fill',
  tpPlanHint: 'filling fine plan gaps',
  'tpNote_coarse-stall': 'coarse stall → plan',
  'tpNote_coarse-threshold': 'coarse ok → plan',
  'tpNote_coarse-ok': 'coarse ok → plan',
  'tpNote_fine-stall': 'fine stall → frontier',
  'tpNote_fine-threshold': 'fine ok → frontier',
  'tpNote_plan-timeout': 'plan timeout → frontier',
  'tpNote_manual': 'manual frontier',
  'tpNote_frontier-stall': 'frontier flat → recall',
  'tpNote_frontier-soft-empty': 'frontier nearly empty → recall',
  'tpNote_frontier-timeout': 'frontier timeout → recall',
  'tpNote_frontier-empty': 'frontier empty → recall',
  'tpNote_departed': 'departed',
  'tpNote_plan-gaps-empty': 'fine gaps empty → frontier',
  tpPhase_frontier: '3 frontier',
  tpPhase_recall: '4 hold',
  tpRecallConfirm: 'Confirm recall',
  tpRecallForming: 'Forming up…',
  'tpNote_formation-ready': 'formation ready · tap to depart',
  mapReset: 'rebuild',
  mapSave: 'export PLY',
  mapStat: (pts, rays) => `${pts.toLocaleString()} pts　${rays.toLocaleString()} rays`,

  hudDevices: 'devices',
  hudPanic: 'panicking',
  hudEvents: 'events',
  hudUplink: 'uplink',
  hudCentral: 'centralized',
};

export class I18n {
  // t('tpMap') gets a string; t('mapStat', 12, 34) gets a parameterised one.
  t(key, ...args) {
    const v = DICT[key];
    return typeof v === 'function' ? v(...args) : (v ?? key);
  }
}
