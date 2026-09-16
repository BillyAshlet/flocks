/**
 * Per-school visualization, switched from the parameter panel.
 *
 * Every visual belongs to the parameters that shape it. Clicking one of those
 * rows in the panel shows the visual for the school being edited, and the row
 * takes the visual's color, so a number and what it draws read as one thing.
 *
 * Visuals are drawn around one representative fish of the school: the
 * camera's selected fish when it belongs to the school, otherwise the first
 * living fish (kept until it dies, so the overlay does not jump around).
 * They draw what the engine actually uses.
 */
import * as THREE from 'three';
import { MECHANISMS } from './mechanisms.js';

/**
 * key -> the panel rows that switch it (global `paths`, per-school `fields`)
 * and its color. `gateFields` are extra rows that make a tier offer the
 * visual: the radius factors sit inside the school editor's sections and
 * appear together with their section's weight. `requires` rows must also be
 * shown: the threat radius shares its factor with hunting, but only means
 * something once prey react (tier 4).
 */
export const VISUALS = {
  separation: {
    label: 'separation radius',
    color: MECHANISMS.separation.color,
    paths: ['perception.separationRadiusFactor'],
    gateFields: ['separationWeight'],
  },
  alignment: {
    label: 'alignment radius',
    color: MECHANISMS.alignment.color,
    paths: ['perception.alignmentRadiusFactor'],
    gateFields: ['alignmentWeight'],
  },
  cohesion: {
    label: 'cohesion radius',
    color: MECHANISMS.cohesion.color,
    fields: ['targetNeighbors'],
  },
  blindCone: {
    label: 'blind cone',
    color: '#6f6a68',
    paths: ['perception.fovDegrees'],
  },
  ray: {
    label: 'look-ahead ray',
    color: MECHANISMS.walls.color,
    paths: ['locomotion.avoidanceLookAhead', 'locomotion.avoidanceWeight'],
  },
  turn: {
    label: 'avoidance turn',
    color: MECHANISMS.walls.color,
    paths: ['locomotion.avoidanceAngleStep'],
  },
  recenter: {
    label: 'recentering pull',
    color: MECHANISMS.walls.color,
    paths: [
      'locomotion.recenterWeight',
      'locomotion.recenterDelay',
      'locomotion.recenterDuration',
    ],
  },
  farSense: {
    label: 'prey sensing radius',
    color: '#8f2d56',
    paths: ['relations.schoolSenseFactor', 'perception.detectionLengthFactor'],
  },
  nearLock: {
    label: 'target lock radius and current target',
    color: '#e0782f',
    paths: ['relations.burstRadiusFactor', 'perception.detectionLengthFactor'],
  },
  threat: {
    label: 'threat radius',
    color: '#5b4b8a',
    paths: ['perception.detectionLengthFactor'],
    requires: ['relations.evadeWeight'],
  },
  signal: {
    label: 'alarm signal radius',
    color: '#a39b2c',
    paths: ['relations.signalRadiusFactor'],
  },
};

export const VISUAL_KEYS = Object.keys(VISUALS);

export function allVisualLayers(on) {
  return Object.fromEntries(VISUAL_KEYS.map((key) => [key, on]));
}

/** Visual keys switched by a global parameter path. */
export function visualsForPath(path) {
  return VISUAL_KEYS.filter((key) => VISUALS[key].paths?.includes(path));
}

/** Visual keys switched by a per-school field (e.g. targetNeighbors). */
export function visualsForField(field) {
  return VISUAL_KEYS.filter((key) => VISUALS[key].fields?.includes(field));
}

/** Whether a tier's panel scope offers the rows behind a visual. */
export function visualOffered(key, scope) {
  if (!scope) return true;
  const visual = VISUALS[key];
  if (!(visual.requires ?? []).every((path) => scope.showGlobal({ path }))) {
    return false;
  }
  return (
    (visual.paths ?? []).some((path) => scope.showGlobal({ path })) ||
    (visual.fields ?? []).some((field) => scope.showSchoolField(field)) ||
    (visual.gateFields ?? []).some((field) => scope.showSchoolField(field))
  );
}

const MIN_SCALE = 1e-4;
const UP = new THREE.Vector3(0, 1, 0);

function wireSphere(color, opacity) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(1, 20, 14),
    new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      transparent: true,
      opacity,
      depthWrite: false,
    })
  );
}

// Unit-radius solid of revolution around +Y: every direction within
// `halfAngle` of +Y, out to distance 1. Works for any angle up to 180 degrees.
function sectorGeometry(halfAngle) {
  const steps = 12;
  const profile = [new THREE.Vector2(0, 0)];
  for (let step = steps; step >= 0; step -= 1) {
    const theta = (halfAngle * step) / steps;
    profile.push(new THREE.Vector2(Math.sin(theta), Math.cos(theta)));
  }
  return new THREE.LatheGeometry(profile, 24);
}

function heading(velocity) {
  const vector = new THREE.Vector3(velocity[0], velocity[1], velocity[2]);
  return vector.lengthSq() > 1e-12 ? vector.normalize() : null;
}

function line(color) {
  const object = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })
  );
  object.frustumCulled = false;
  return object;
}

class SchoolOverlay {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.anchor = -1;

    this.separation = wireSphere(VISUALS.separation.color, 0.55);
    this.alignment = wireSphere(VISUALS.alignment.color, 0.4);
    this.cohesion = wireSphere(VISUALS.cohesion.color, 0.3);

    this.ray = line(VISUALS.ray.color);
    this.turnArrow = new THREE.ArrowHelper(UP, new THREE.Vector3(), 1, VISUALS.turn.color);
    this.recenterArrow = new THREE.ArrowHelper(
      UP,
      new THREE.Vector3(),
      1,
      VISUALS.recenter.color
    );

    this.blindAngle = -1;
    this.blindCone = new THREE.Mesh(
      sectorGeometry(0),
      new THREE.MeshBasicMaterial({
        color: VISUALS.blindCone.color,
        wireframe: true,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      })
    );

    this.farSense = wireSphere(VISUALS.farSense.color, 0.22);
    this.nearLock = wireSphere(VISUALS.nearLock.color, 0.45);
    // The target line lives in world space, not relative to the anchor.
    this.targetLine = line(VISUALS.nearLock.color);

    this.threat = wireSphere(VISUALS.threat.color, 0.3);
    this.signal = wireSphere(VISUALS.signal.color, 0.25);

    this.group.add(
      this.separation,
      this.alignment,
      this.cohesion,
      this.ray,
      this.turnArrow,
      this.recenterArrow,
      this.blindCone,
      this.farSense,
      this.nearLock,
      this.threat,
      this.signal
    );
    parent.add(this.group, this.targetLine);
  }

  hide() {
    this.group.visible = false;
    this.targetLine.visible = false;
  }

  dispose() {
    this.group.removeFromParent();
    this.targetLine.removeFromParent();
    this.group.traverse((object) => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
    this.targetLine.geometry.dispose();
    this.targetLine.material.dispose();
  }

  // Selected fish if it is ours, else keep the current anchor while it lives,
  // else the first living fish of the school.
  pickAnchor(simulation, schoolIndex, selected) {
    const range = simulation.schoolRanges?.[schoolIndex];
    if (!range) return -1;
    const ours = (index) =>
      index >= range.start && index < range.end && simulation.alive[index];
    if (ours(selected)) return (this.anchor = selected);
    if (ours(this.anchor)) return this.anchor;
    for (let index = range.start; index < range.end; index += 1) {
      if (simulation.alive[index]) return (this.anchor = index);
    }
    return (this.anchor = -1);
  }

  // Ray: faint when the way ahead is clear, solid up to the hit point when it
  // hits something. Turn arrow: the direction chosen on a hit. Recenter arrow:
  // toward the tank centre while the delayed pull acts.
  updateAvoidance(simulation, config, index, forward, layers) {
    const locomotion = config.locomotion;
    const length = locomotion.avoidanceLookAhead;
    const hit = simulation.avoidanceHits?.[index] ?? Infinity;
    const hitting = Number.isFinite(hit);

    this.ray.visible = Boolean(layers.ray && forward && length > 0);
    if (this.ray.visible) {
      const reach = hitting ? Math.min(hit, length) : length;
      const position = this.ray.geometry.attributes.position;
      position.setXYZ(1, forward.x * reach, forward.y * reach, forward.z * reach);
      position.needsUpdate = true;
      this.ray.material.opacity = hitting ? 0.95 : 0.35;
    }

    const offset = index * 3;
    const turn = new THREE.Vector3(
      simulation.avoidanceDirections?.[offset] ?? 0,
      simulation.avoidanceDirections?.[offset + 1] ?? 0,
      simulation.avoidanceDirections?.[offset + 2] ?? 0
    );
    this.turnArrow.visible = Boolean(layers.turn && hitting && turn.lengthSq() > 1e-12);
    if (this.turnArrow.visible) {
      const arrowLength = Math.max(length, 0.1);
      this.turnArrow.setDirection(turn.normalize());
      this.turnArrow.setLength(arrowLength, arrowLength * 0.25, arrowLength * 0.12);
    }

    const timer = simulation.recenterTimers?.[index] ?? 0;
    const toCentre = new THREE.Vector3(
      -simulation.positions[offset],
      -simulation.positions[offset + 1],
      -simulation.positions[offset + 2]
    );
    this.recenterArrow.visible = Boolean(
      layers.recenter &&
        timer > 0 &&
        timer <= locomotion.recenterDuration &&
        locomotion.recenterWeight > 0 &&
        toCentre.lengthSq() > 1e-12
    );
    if (this.recenterArrow.visible) {
      const arrowLength = Math.max(length, 0.1);
      this.recenterArrow.setDirection(toCentre.normalize());
      this.recenterArrow.setLength(arrowLength, arrowLength * 0.25, arrowLength * 0.12);
    }
  }

  update(simulation, config, schoolIndex, layers, selected) {
    const anyLayer = VISUAL_KEYS.some((key) => layers[key]);
    const index = anyLayer ? this.pickAnchor(simulation, schoolIndex, selected) : -1;
    const fish = index >= 0 ? simulation.fish(index) : null;
    if (!fish?.alive) {
      this.hide();
      return;
    }
    const derived = simulation.derived.schools[schoolIndex];
    const relations = config.relations;
    const predation = relations.enabled !== false;
    this.group.visible = true;
    this.group.position.set(fish.position[0], fish.position[1], fish.position[2]);

    const radius = (object, on, value) => {
      object.visible = Boolean(on);
      if (object.visible) object.scale.setScalar(Math.max(value, MIN_SCALE));
    };
    radius(this.separation, layers.separation, derived.separationRadius);
    radius(this.alignment, layers.alignment, derived.alignmentRadius);
    radius(this.cohesion, layers.cohesion, derived.cohesionRadius);

    const forward = heading(fish.velocity);
    this.updateAvoidance(simulation, config, index, forward, layers);

    const fov = config.perception.fovDegrees;
    this.blindCone.visible = Boolean(layers.blindCone && forward && fov < 360);
    if (this.blindCone.visible) {
      const halfAngle = ((360 - fov) * Math.PI) / 360;
      if (halfAngle !== this.blindAngle) {
        this.blindCone.geometry.dispose();
        this.blindCone.geometry = sectorGeometry(halfAngle);
        this.blindAngle = halfAngle;
      }
      this.blindCone.quaternion.setFromUnitVectors(UP, forward.clone().negate());
      this.blindCone.scale.setScalar(Math.max(derived.cohesionRadius, MIN_SCALE));
    }

    radius(
      this.farSense,
      layers.farSense && predation,
      derived.detectionLength * relations.schoolSenseFactor
    );
    radius(
      this.nearLock,
      layers.nearLock && predation,
      derived.detectionLength * relations.burstRadiusFactor
    );
    const target =
      layers.nearLock && predation ? simulation.pursuitTargets?.[index] ?? -1 : -1;
    const targetFish = target >= 0 ? simulation.fish(target) : null;
    this.targetLine.visible = Boolean(targetFish?.alive);
    if (this.targetLine.visible) {
      const position = this.targetLine.geometry.attributes.position;
      position.setXYZ(0, fish.position[0], fish.position[1], fish.position[2]);
      position.setXYZ(
        1,
        targetFish.position[0],
        targetFish.position[1],
        targetFish.position[2]
      );
      position.needsUpdate = true;
    }

    radius(this.threat, layers.threat && predation, derived.panicRadius);
    // The signal radius belongs to emergency alignment; without it there is
    // nothing to draw.
    radius(
      this.signal,
      layers.signal && predation && relations.emergencyAlignment !== false,
      derived.alignmentRadius * relations.signalRadiusFactor
    );
  }
}

export class SchoolVisualizer {
  constructor(scene) {
    this.scene = scene;
    this.overlays = [];
  }

  dispose() {
    for (const overlay of this.overlays) overlay.dispose();
    this.overlays = [];
  }

  /**
   * @param layersBySchool one object per school index, e.g. { cohesion: true }
   * @param selected       the camera's selected fish index, or -1
   */
  update(simulation, config, layersBySchool = [], selected = -1) {
    const schoolCount = simulation?.derived?.schools?.length ?? 0;
    while (this.overlays.length > schoolCount) this.overlays.pop().dispose();
    while (this.overlays.length < schoolCount) {
      this.overlays.push(new SchoolOverlay(this.scene));
    }
    this.overlays.forEach((overlay, schoolIndex) => {
      overlay.update(simulation, config, schoolIndex, layersBySchool[schoolIndex] ?? {}, selected);
    });
  }
}
