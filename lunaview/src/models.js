// Rover 3D models (glTF), loaded once and normalised: wheels on y = 0, centred, facing -Z, and
// scaled to the rover's real length in metres.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// file: in public/models; forward: the model's own forward axis; credit: shown in the app.
export const MODELS = {
  micro: { file: 'models/rover-quaternius.glb', forward: '+z', lengthM: 0.9, credit: 'Rover by Quaternius (CC0)' },
  mid: { file: 'models/rover-poly.glb', forward: '+z', lengthM: 1.8, credit: 'Space rover by Poly by Google (CC BY 3.0)' },
  large: { file: 'models/rover-curiosity.glb', forward: '+x', lengthM: 3.0, credit: 'Curiosity Rover by Keen Chan (CC BY 3.0)' },
};

const loader = new GLTFLoader();
const cache = new Map();

function load(file) {
  if (!cache.has(file)) cache.set(file, new Promise((ok, fail) => loader.load(file, (g) => ok(g.scene), undefined, fail)));
  return cache.get(file);
}

// A fresh, normalised copy of a rover model: { object, wheels } (wheels: meshes to spin, may be empty).
export async function roverModel(id) {
  const spec = MODELS[id] ?? MODELS.mid;
  const src = await load(spec.file);
  const inner = src.clone(true);
  const turn = { '+z': Math.PI, '-z': 0, '+x': Math.PI / 2, '-x': -Math.PI / 2 }[spec.forward] ?? 0;
  inner.rotation.y = turn;
  const holder = new THREE.Group();
  holder.add(inner);
  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  const k = spec.lengthM / Math.max(size.z, 1e-6);
  inner.position.set(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
  holder.scale.setScalar(k);
  const object = new THREE.Group();
  object.add(holder);
  const wheels = [];
  object.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = false;
      // Untextured flat-coloured materials read better a little rough and metallic.
      if (o.material && !o.material.map) { o.material = o.material.clone(); o.material.roughness = 0.6; o.material.metalness = 0.25; }
    }
    if (/wheel/i.test(o.name)) wheels.push(o);
  });
  return { object, wheels, spec, size: { x: size.x * k, y: size.y * k, z: spec.lengthM } };
}
