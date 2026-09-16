import * as THREE from 'three';

function makeSphere(color, opacity) {
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

export class RadiusVisualizer {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    this.boid = {
      separation: makeSphere('#7ea8c4', 0.55),
      alignment: makeSphere('#5f8daa', 0.4),
      cohesion: makeSphere('#416f8f', 0.28),
    };
    this.combat = {
      burst: makeSphere('#c98b5f', 0.45),
      hunt: makeSphere('#b35d4d', 0.34),
      panic: makeSphere('#8f4d74', 0.28),
    };
    for (const mesh of Object.values(this.boid)) this.group.add(mesh);
    for (const mesh of Object.values(this.combat)) this.group.add(mesh);
    this.scene.add(this.group);
  }

  dispose() {
    this.group.removeFromParent();
    for (const mesh of [...Object.values(this.boid), ...Object.values(this.combat)]) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
  }

  update(simulation, config) {
    const debug = config?.debug ?? {};
    const fish = simulation?.fish?.(0);
    const showBoid = Boolean(debug.perceptionRadii);
    const showCombat = Boolean(debug.combatRadii);
    if (!fish?.alive || (!showBoid && !showCombat)) {
      this.group.visible = false;
      return;
    }

    const schoolIndex = fish.schoolIndex;
    const derived = simulation.derived.schools[schoolIndex];
    this.group.visible = true;
    this.group.position.set(fish.position[0], fish.position[1], fish.position[2]);

    this.boid.separation.visible = showBoid;
    this.boid.alignment.visible = showBoid;
    this.boid.cohesion.visible = showBoid;
    if (showBoid) {
      this.boid.separation.scale.setScalar(Math.max(derived.separationRadius, 1e-4));
      this.boid.alignment.scale.setScalar(Math.max(derived.alignmentRadius, 1e-4));
      this.boid.cohesion.scale.setScalar(Math.max(derived.cohesionRadius, 1e-4));
    }

    this.combat.burst.visible = showCombat;
    this.combat.hunt.visible = showCombat;
    this.combat.panic.visible = showCombat;
    if (showCombat) {
      const hunt = Math.max(derived.detectionLength, 1e-4);
      const burst = Math.max(
        derived.detectionLength * config.relations.burstRadiusFactor,
        1e-4
      );
      const panic = Math.max(derived.panicRadius, 1e-4);
      this.combat.burst.scale.setScalar(burst);
      this.combat.hunt.scale.setScalar(hunt);
      this.combat.panic.scale.setScalar(panic);
    }
  }
}
