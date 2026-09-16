/**
 * Per-school visualization.
 *
 * Each school can switch on its own layers. A layer is drawn around one
 * representative fish of that school: the camera's selected fish when it
 * belongs to the school, otherwise the first living fish (kept until it dies,
 * so the overlay does not jump around).
 *
 * Layers draw what the engine actually uses:
 *   reynolds    separation / alignment / cohesion radii
 *   walls       the look-ahead ray along the heading (amber up to the hit
 *               when it hits something), the direction the fish turns to,
 *               and a blue arrow toward the centre while recentering acts
 *   fieldOfView the blind cone behind the fish; pairs inside it are ignored
 *   hunting     far sense (steer to prey centroid), near lock (pick one
 *               target), and a line to the current target
 *   panic       threat radius (sees a predator) and, with emergency
 *               alignment on, signal radius (passes the escape heading on)
 */
import * as THREE from 'three';

export const VISUAL_LAYERS = [
  'reynolds',
  'walls',
  'fieldOfView',
  'hunting',
  'panic',
];

export function emptyVisualLayers() {
  return Object.fromEntries(VISUAL_LAYERS.map((layer) => [layer, false]));
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

class SchoolOverlay {
  constructor(parent) {
    this.group = new THREE.Group();
    this.group.visible = false;
    this.anchor = -1;

    this.reynolds = new THREE.Group();
    this.separation = wireSphere('#7ea8c4', 0.55);
    this.alignment = wireSphere('#5f8daa', 0.4);
    this.cohesion = wireSphere('#416f8f', 0.28);
    this.reynolds.add(this.separation, this.alignment, this.cohesion);

    this.ray = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: '#8a8a94', transparent: true, opacity: 0.8 })
    );
    this.ray.frustumCulled = false;
    this.wallArrow = new THREE.ArrowHelper(UP, new THREE.Vector3(), 1, '#a8842a');
    this.recenterArrow = new THREE.ArrowHelper(UP, new THREE.Vector3(), 1, '#4f7fa8');

    this.blindAngle = -1;
    this.blindCone = new THREE.Mesh(
      sectorGeometry(0),
      new THREE.MeshBasicMaterial({
        color: '#3d3d52',
        wireframe: true,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      })
    );

    this.hunting = new THREE.Group();
    this.farSense = wireSphere('#b35d4d', 0.22);
    this.nearLock = wireSphere('#c98b5f', 0.45);
    this.hunting.add(this.farSense, this.nearLock);
    this.targetLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: '#e0785f', transparent: true, opacity: 0.9 })
    );
    this.targetLine.frustumCulled = false;

    this.panic = new THREE.Group();
    this.threat = wireSphere('#8f4d74', 0.3);
    this.signal = wireSphere('#b57aa6', 0.22);
    this.panic.add(this.threat, this.signal);

    this.group.add(this.reynolds, this.ray, this.wallArrow, this.recenterArrow, this.blindCone, this.hunting, this.panic);
    // The target line lives in world space, not relative to the anchor.
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

  // The ray is grey when clear. On a hit it turns amber and stops at the hit
  // point, and an arrow shows the direction the fish turns to.
  updateAvoidance(simulation, config, index, forward, on) {
    const length = config.locomotion.avoidanceLookAhead;
    this.ray.visible = Boolean(on && forward && length > 0);
    this.wallArrow.visible = false;
    this.recenterArrow.visible = false;
    if (!on) return;
    const timer = simulation.recenterTimers?.[index] ?? 0;
    const toCentre = new THREE.Vector3(
      -simulation.positions[index * 3],
      -simulation.positions[index * 3 + 1],
      -simulation.positions[index * 3 + 2]
    );
    if (
      timer > 0 &&
      timer <= config.locomotion.recenterDuration &&
      config.locomotion.recenterWeight > 0 &&
      toCentre.lengthSq() > 1e-12
    ) {
      const arrowLength = Math.max(length, 0.1);
      this.recenterArrow.visible = true;
      this.recenterArrow.setDirection(toCentre.normalize());
      this.recenterArrow.setLength(arrowLength, arrowLength * 0.25, arrowLength * 0.12);
    }
    if (!this.ray.visible) return;
    const hit = simulation.avoidanceHits?.[index] ?? Infinity;
    const hitting = Number.isFinite(hit);
    const reach = hitting ? Math.min(hit, length) : length;
    const position = this.ray.geometry.attributes.position;
    position.setXYZ(1, forward.x * reach, forward.y * reach, forward.z * reach);
    position.needsUpdate = true;
    this.ray.material.color.set(hitting ? '#d08a2a' : '#8a8a94');
    if (!hitting) return;
    const offset = index * 3;
    const direction = new THREE.Vector3(
      simulation.avoidanceDirections[offset],
      simulation.avoidanceDirections[offset + 1],
      simulation.avoidanceDirections[offset + 2]
    );
    if (direction.lengthSq() < 1e-12) return;
    this.wallArrow.visible = true;
    this.wallArrow.setDirection(direction);
    this.wallArrow.setLength(length, length * 0.25, length * 0.12);
  }

  update(simulation, config, schoolIndex, layers, selected) {
    const anyLayer = VISUAL_LAYERS.some((layer) => layers[layer]);
    const index = anyLayer ? this.pickAnchor(simulation, schoolIndex, selected) : -1;
    const fish = index >= 0 ? simulation.fish(index) : null;
    if (!fish?.alive) {
      this.hide();
      return;
    }
    const derived = simulation.derived.schools[schoolIndex];
    const relations = config.relations;
    this.group.visible = true;
    this.group.position.set(fish.position[0], fish.position[1], fish.position[2]);

    this.reynolds.visible = Boolean(layers.reynolds);
    if (this.reynolds.visible) {
      this.separation.scale.setScalar(Math.max(derived.separationRadius, MIN_SCALE));
      this.alignment.scale.setScalar(Math.max(derived.alignmentRadius, MIN_SCALE));
      this.cohesion.scale.setScalar(Math.max(derived.cohesionRadius, MIN_SCALE));
    }

    const forward = heading(fish.velocity);
    this.updateAvoidance(simulation, config, index, forward, Boolean(layers.walls));
    const fov = config.perception.fovDegrees;
    this.blindCone.visible = Boolean(layers.fieldOfView && forward && fov < 360);
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

    const huntingOn = Boolean(layers.hunting && relations.enabled !== false);
    this.hunting.visible = huntingOn;
    if (huntingOn) {
      this.farSense.scale.setScalar(
        Math.max(derived.detectionLength * relations.schoolSenseFactor, MIN_SCALE)
      );
      this.nearLock.scale.setScalar(
        Math.max(derived.detectionLength * relations.burstRadiusFactor, MIN_SCALE)
      );
    }
    const target = huntingOn ? simulation.pursuitTargets?.[index] ?? -1 : -1;
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

    this.panic.visible = Boolean(layers.panic && relations.enabled !== false);
    // The signal radius belongs to emergency alignment; without it only the
    // threat radius means anything.
    this.signal.visible = relations.emergencyAlignment !== false;
    if (this.panic.visible) {
      this.threat.scale.setScalar(Math.max(derived.panicRadius, MIN_SCALE));
      this.signal.scale.setScalar(
        Math.max(derived.alignmentRadius * relations.signalRadiusFactor, MIN_SCALE)
      );
    }
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
   * @param layersBySchool one object per school index, e.g. { reynolds: true }
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
