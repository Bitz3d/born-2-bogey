import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { AgXToneMapping, Box3, Color, DoubleSide, HalfFloatType, LinearSRGBColorSpace, MOUSE, PMREMGenerator, TOUCH, Vector2, Vector3, Vector4, VSMShadowMap, WebGLRenderTarget } from 'three';
import { ColorEnvironment } from 'three/examples/jsm/environments/ColorEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { distanceLimitsForFit, fitDistanceForAspect, fitScaleForAspect } from './cameraFraming.mjs';

export type PresetName = 'front' | 'quarter' | 'side' | 'rear' | 'reset';
export type InteractionMode = 'rotate' | 'pan';
export type CameraCommand =
  | { sequence: number; action: 'preset'; preset: PresetName }
  | { sequence: number; action: 'zoom'; factor: number }
  | null;

const REVIEW_DISTANCE = 2.4;
// Camera presets as offsets from their targets, in viewer units. reset and quarter are the approved scene's cameras
// B2B_Cam_Front and B2B_Cam_Quarter: Blender (x, y, z) -> 0.6 * (x, z - 0.675, -(y + 0.00075)) around the recentred
// scene. At aspects of 1.3 and wider the start view is exactly B2B_Cam_Front; narrower views move back along the same
// line (cameraFraming.mjs). quarter sits 1.3x and side 1.08x further out, so that the whole scene stays in frame.
type PresetSpec = { from: [number, number, number]; target: [number, number, number]; factor: number };
const PRESETS: Record<PresetName, PresetSpec> = {
  reset: { from: [0, 0.375, 3.47955], target: [0, -0.015, -0.00045], factor: 1 },
  quarter: { from: [-2.1, 1.275, 2.99955], target: [0, -0.045, -0.00045], factor: 1.3 },
  front: { from: [0, 0.15, 3], target: [0, 0.02, 0], factor: 1 },
  side: { from: [-3, 0.35, 0], target: [0, 0, 0], factor: 1.08 },
  rear: { from: [0, 0.35, -3], target: [0, 0, 0], factor: 1 },
};
const presetOffset = (spec: PresetSpec) => new Vector3(...spec.from).sub(new Vector3(...spec.target));
const FULL_SCENE_DISTANCE = presetOffset(PRESETS.reset).length();
const MIN_DISTANCE = 0.4;
const MAX_DISTANCE = 6;

// Look derived from the approved Blender scene (AgX view, three area lights, uniform grey world 0.32/0.32/0.34).
// Each area light becomes a directional light from the same side (Blender x, y, z -> x, z - 0.675, -y) with its
// irradiance at the scene centre, E = P / (pi d^2). The world becomes a uniform image-based environment, so metals
// reflect it as in Blender. TONE_MAPPING_EXPOSURE is calibrated against the approved render (see REVIEW.md).
type Light = { name: string; position: [number, number, number]; intensity: number };
const LIGHTS: Light[] = [
  { name: 'key', position: [-3.5, 3.825, 4.5], intensity: 14.86 },
  { name: 'fill', position: [4.0, 1.825, 3.5], intensity: 9.07 },
  { name: 'rim', position: [0.5, 3.325, -4.5], intensity: 14.12 },
];
const WORLD_LINEAR: [number, number, number] = [0.32, 0.32, 0.34];
const TONE_MAPPING_EXPOSURE = 0.6;
// The background shows the render's sRGB #828385 exactly: its HDR value is solved through the same AgX curve.
const BACKGROUND_SRGB: [number, number, number] = [130 / 255, 131 / 255, 133 / 255];
const BACKGROUND = '#828385';
// Soft shadow from the key light (VSM). The Blender key is a 3.5 m area light; a fixed blur of about 6 cm (real size)
// approximates its contact shadows. Lights and model are static, so the shadow map is rendered once per model.
const SHADOW_MAP = { enabled: true, type: VSMShadowMap, autoUpdate: false };
const KEY_SHADOW = { mapSize: 2048, radius: 12, blurSamples: 16, bias: -0.0005, normalBias: 0, extent: 1.6, near: 5.0, far: 8.8 };
// Ambient occlusion (three.js GTAO) stands in for the contact darkening of the large Blender area lights.
const GTAO = { material: { radius: 0.15, distanceExponent: 1, thickness: 1, scale: 1, samples: 16 }, blendIntensity: 1 };

// three.js AgX for one neutral channel (its inset/outset matrices keep greys grey), returned display-encoded (sRGB).
function agxDisplay(value: number): number {
  const x = Math.min(1, Math.max(0, (Math.log2(Math.max(value, 1e-10)) + 12.47393) / 16.499999));
  const x2 = x * x;
  const x4 = x2 * x2;
  const sigmoid = 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
  const linear = Math.min(1, Math.pow(Math.max(0, sigmoid), 2.2));
  return linear <= 0.0031308 ? 12.92 * linear : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
}

function radianceForDisplay(display: number, exposure: number): number {
  let low = -12.47393;
  let high = 4.026069;
  for (let step = 0; step < 60; step += 1) {
    const middle = (low + high) / 2;
    if (agxDisplay(2 ** middle) < display) low = middle;
    else high = middle;
  }
  return 2 ** ((low + high) / 2) / exposure;
}

function distanceForScale(scale: number): number {
  return scale >= 1 ? FULL_SCENE_DISTANCE : REVIEW_DISTANCE;
}

function presetFor(name: PresetName, distance: number): { position: [number, number, number]; target: [number, number, number] } {
  const spec = PRESETS[name];
  const position = new Vector3(...spec.target).addScaledVector(presetOffset(spec).normalize(), distance * spec.factor);
  return { position: position.toArray() as [number, number, number], target: spec.target };
}

function Scene({
  gltf,
  scale,
  command,
  interactionMode,
  onContextLost,
  setProbe,
}: {
  gltf: GLTF;
  scale: number;
  command: CameraCommand;
  interactionMode: InteractionMode;
  onContextLost: () => void;
  setProbe: (probe: (() => object) | null) => void;
}) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, gl, invalidate, scene, size, viewport } = useThree();
  const baselineDistance = distanceForScale(scale);
  const isFullScene = scale >= 1;
  const aspect = size.height > 0 ? size.width / size.height : (camera as any).aspect;
  const fitDistance = fitDistanceForAspect(baselineDistance, isFullScene, aspect);
  const fitScale = fitScaleForAspect(isFullScene, aspect);
  const distanceLimits = distanceLimitsForFit(fitDistance, isFullScene, MIN_DISTANCE, MAX_DISTANCE, baselineDistance);
  const previousFitDistance = useRef(baselineDistance);
  const keyLight = useRef<any>(null);
  const shadowDirty = useRef(true);
  // renderer.info of the beauty pass alone; the composer's later passes would otherwise overwrite it.
  const beauty = useRef({ triangles: 0, calls: 0 });

  // HDR composer: scene -> GTAO -> OutputPass (AgX tone mapping and sRGB). Without renderable half floats the
  // scene is drawn directly, without GTAO.
  const effects = useMemo(() => {
    if (!(gl.extensions.has('EXT_color_buffer_float') || gl.extensions.has('EXT_color_buffer_half_float'))) return null;
    const composer = new EffectComposer(gl, new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 }));
    const renderPass = new RenderPass(scene, camera);
    const renderScene = renderPass.render.bind(renderPass);
    renderPass.render = (...args: Parameters<typeof renderScene>) => {
      renderScene(...args);
      beauty.current = { triangles: gl.info.render.triangles, calls: gl.info.render.calls };
    };
    const gtao = new GTAOPass(scene, camera, 1, 1);
    gtao.updateGtaoMaterial(GTAO.material);
    gtao.blendIntensity = GTAO.blendIntensity;
    const output = new OutputPass();
    composer.addPass(renderPass);
    composer.addPass(gtao);
    composer.addPass(output);
    return { composer, passes: [renderPass, gtao, output] };
  }, [camera, gl, scene]);

  useEffect(() => () => {
    if (!effects) return;
    for (const pass of effects.passes) pass.dispose();
    effects.composer.dispose();
  }, [effects]);

  useLayoutEffect(() => {
    if (!effects) return;
    effects.composer.setPixelRatio(viewport.dpr);
    effects.composer.setSize(size.width, size.height);
    invalidate();
  }, [effects, invalidate, size.height, size.width, viewport.dpr]);

  useFrame(() => {
    if (shadowDirty.current) {
      gl.shadowMap.needsUpdate = true;
      shadowDirty.current = false;
    }
    if (effects) {
      effects.composer.render();
    } else {
      gl.render(scene, camera);
      beauty.current = { triangles: gl.info.render.triangles, calls: gl.info.render.calls };
    }
  }, 1);

  useEffect(() => {
    scene.background = effects
      ? new Color().setRGB(...(BACKGROUND_SRGB.map((value) => radianceForDisplay(value, TONE_MAPPING_EXPOSURE)) as [number, number, number]), LinearSRGBColorSpace)
      : new Color(BACKGROUND);
    invalidate();
    return () => {
      scene.background = null;
    };
  }, [effects, invalidate, scene]);

  // Model setup before its first frame: full anisotropic filtering, shadows from everything except blended decals
  // (a blended quad would cast its whole rectangle), and one shadow-map update.
  useLayoutEffect(() => {
    const maxAnisotropy = gl.capabilities.getMaxAnisotropy();
    gltf.scene.traverse((object: any) => {
      if (!object.isMesh) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      object.castShadow = !materials.some((material: any) => material.transparent);
      object.receiveShadow = true;
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if ((value as any)?.isTexture) {
            (value as any).anisotropy = maxAnisotropy;
            (value as any).needsUpdate = true;
          }
        }
      }
    });
    shadowDirty.current = true;
    invalidate();
  }, [gl, gltf, invalidate]);

  useLayoutEffect(() => {
    const light = keyLight.current;
    if (!light) return;
    light.castShadow = true;
    const shadow = light.shadow;
    shadow.mapSize.set(KEY_SHADOW.mapSize, KEY_SHADOW.mapSize);
    shadow.radius = KEY_SHADOW.radius;
    shadow.blurSamples = KEY_SHADOW.blurSamples;
    shadow.bias = KEY_SHADOW.bias;
    shadow.normalBias = KEY_SHADOW.normalBias;
    const shadowCamera = shadow.camera;
    shadowCamera.left = -KEY_SHADOW.extent;
    shadowCamera.right = KEY_SHADOW.extent;
    shadowCamera.top = KEY_SHADOW.extent;
    shadowCamera.bottom = -KEY_SHADOW.extent;
    shadowCamera.near = KEY_SHADOW.near;
    shadowCamera.far = KEY_SHADOW.far;
    shadowCamera.updateProjectionMatrix();
    shadowDirty.current = true;
    invalidate();
  }, [invalidate]);

  // Start exactly in the reset preset (its target is not the origin); the fit-distance effect below then scales it.
  useLayoutEffect(() => {
    const current = controls.current;
    if (!current) return;
    const preset = presetFor('reset', baselineDistance);
    camera.position.fromArray(preset.position);
    current.target.fromArray(preset.target);
    current.update();
    invalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const canvas = gl.domElement;
    const lost = (event: Event) => {
      event.preventDefault();
      onContextLost();
    };
    const focusCanvas = () => canvas.focus({ preventScroll: true });
    canvas.addEventListener('webglcontextlost', lost, false);
    canvas.addEventListener('pointerdown', focusCanvas, false);
    return () => {
      canvas.removeEventListener('webglcontextlost', lost, false);
      canvas.removeEventListener('pointerdown', focusCanvas, false);
    };
  }, [gl, onContextLost]);

  useEffect(() => {
    gl.toneMapping = AgXToneMapping;
    gl.toneMappingExposure = TONE_MAPPING_EXPOSURE;
    const pmrem = new PMREMGenerator(gl);
    const world = new ColorEnvironment(new Color().setRGB(...WORLD_LINEAR, LinearSRGBColorSpace));
    const target = pmrem.fromScene(world);
    scene.environment = target.texture;
    scene.environmentIntensity = 1;
    invalidate();
    return () => {
      scene.environment = null;
      target.dispose();
      world.dispose();
      pmrem.dispose();
    };
  }, [gl, invalidate, scene]);

  useEffect(() => {
    const current = controls.current;
    if (!current) return;
    current.listenToKeyEvents(gl.domElement);
    return () => current.stopListenToKeyEvents();
  }, [gl]);

  useEffect(() => {
    setProbe(() => {
      const canvas = gl.domElement;
      const canvasRect = canvas.getBoundingClientRect();
      const shellRect = canvas.closest('.viewer-shell')?.getBoundingClientRect();
      const drawingBuffer = gl.getDrawingBufferSize(new Vector2());
      const rendererViewport = gl.getViewport(new Vector4());
      const context = gl.getContext();
      const gpuViewport = Array.from(context.getParameter(context.VIEWPORT) as Int32Array);
      let intendedBounds = null;
      if (isFullScene) {
        // Rollercoaster's source scene is the intended review object. Project its
        // post-scale world AABB for test evidence without changing model content.
        gltf.scene.updateWorldMatrix(true, true);
        camera.updateMatrixWorld();
        const worldBox = new Box3().setFromObject(gltf.scene, true);
        const ndcMinimum = new Vector3(Infinity, Infinity, Infinity);
        const ndcMaximum = new Vector3(-Infinity, -Infinity, -Infinity);
        for (const x of [worldBox.min.x, worldBox.max.x]) {
          for (const y of [worldBox.min.y, worldBox.max.y]) {
            for (const z of [worldBox.min.z, worldBox.max.z]) {
              const projected = new Vector3(x, y, z).project(camera);
              ndcMinimum.min(projected);
              ndcMaximum.max(projected);
            }
          }
        }
        intendedBounds = {
          sourceWorldBox: { minimum: worldBox.min.toArray(), maximum: worldBox.max.toArray() },
          ndc: { minimum: ndcMinimum.toArray(), maximum: ndcMaximum.toArray() },
          canvasPixels: {
            left: ((ndcMinimum.x + 1) / 2) * canvasRect.width,
            right: ((ndcMaximum.x + 1) / 2) * canvasRect.width,
            top: ((1 - ndcMaximum.y) / 2) * canvasRect.height,
            bottom: ((1 - ndcMinimum.y) / 2) * canvasRect.height,
          },
          maximumAbsoluteXY: Math.max(Math.abs(ndcMinimum.x), Math.abs(ndcMaximum.x), Math.abs(ndcMinimum.y), Math.abs(ndcMaximum.y)),
          fullyInsideClip: ndcMinimum.x >= -1 && ndcMaximum.x <= 1 && ndcMinimum.y >= -1 && ndcMaximum.y <= 1 && ndcMinimum.z >= -1 && ndcMaximum.z <= 1,
        };
      }
      // Exact draw accounting: three.js draws a transparent DoubleSide material twice (back, then front faces).
      const accounting = { sceneTriangles: 0, scenePrimitives: 0, doublePassTriangles: 0, doublePassPrimitives: 0 };
      gltf.scene.traverseVisible((object: any) => {
        if (!object.isMesh) return;
        const geometry = object.geometry;
        const triangles = (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3;
        accounting.sceneTriangles += triangles;
        accounting.scenePrimitives += 1;
        const material = object.material;
        if (material.transparent && material.side === DoubleSide && !material.forceSinglePass) {
          accounting.doublePassTriangles += triangles;
          accounting.doublePassPrimitives += 1;
        }
      });
      return {
        triangles: beauty.current.triangles,
        drawCalls: beauty.current.calls,
        accounting,
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
        contextLost: context.isContextLost(),
        interactionMode,
        camera: {
          position: camera.position.toArray(),
          target: controls.current?.target.toArray() ?? null,
          distance: controls.current ? camera.position.distanceTo(controls.current.target) : null,
          fov: (camera as any).fov,
          aspect: (camera as any).aspect ?? null,
          baselineDistance,
          fitDistance,
          fitScale,
          minimumDistance: distanceLimits.minimum,
          maximumDistance: distanceLimits.maximum,
        },
        intendedBounds,
        presentation: {
          background: (scene.background as any)?.getHexString?.() ?? null,
          backgroundLinear: (scene.background as any)?.toArray?.() ?? null,
          effects: {
            composer: Boolean(effects),
            gtao: effects ? GTAO : null,
            shadowMap: { enabled: gl.shadowMap.enabled, type: gl.shadowMap.type, autoUpdate: gl.shadowMap.autoUpdate },
            keyShadow: keyLight.current ? { castShadow: keyLight.current.castShadow, mapSize: keyLight.current.shadow.mapSize.toArray(), radius: keyLight.current.shadow.radius } : null,
            maxAnisotropy: gl.capabilities.getMaxAnisotropy(),
          },
          toneMapping: gl.toneMapping,
          toneMappingExposure: gl.toneMappingExposure,
          environment: Boolean(scene.environment),
          environmentIntensity: (scene as any).environmentIntensity ?? null,
          modelScale: gltf.scene.scale.toArray(),
          lights: scene.children
            .filter((object: any) => object.isLight)
            .map((light: any) => ({ type: light.type, intensity: light.intensity, position: light.position.toArray() })),
        },
        dimensions: {
          canvasCss: [canvasRect.width, canvasRect.height],
          viewerShellCss: shellRect ? [shellRect.width, shellRect.height] : null,
          backingBuffer: [canvas.width, canvas.height],
          drawingBuffer: drawingBuffer.toArray(),
          rendererViewport: rendererViewport.toArray(),
          gpuViewport,
          r3fSize: [size.width, size.height],
          dpr: gl.getPixelRatio(),
        },
        renderFrame: gl.info.render.frame,
        canvas: [canvas.width, canvas.height],
      };
    });
    invalidate();
    return () => setProbe(null);
  }, [baselineDistance, camera, distanceLimits.maximum, distanceLimits.minimum, effects, fitDistance, fitScale, gl, gltf.scene, interactionMode, invalidate, isFullScene, scene, setProbe, size.height, size.width]);

  useEffect(() => {
    const current = controls.current;
    if (!current) return;
    const priorFit = previousFitDistance.current;
    if (Math.abs(fitDistance - priorFit) > 0.000001) {
      const offset = camera.position.clone().sub(current.target);
      const relativeZoom = offset.length() / priorFit;
      const nextDistance = Math.min(distanceLimits.maximum, Math.max(distanceLimits.minimum, fitDistance * relativeZoom));
      offset.setLength(nextDistance);
      camera.position.copy(current.target).add(offset);
      current.update();
    }
    previousFitDistance.current = fitDistance;
    // The canvas uses demand rendering, so every ResizeObserver size commit must
    // explicitly produce a frame with the updated camera projection/viewport.
    invalidate();
  }, [camera, distanceLimits.maximum, distanceLimits.minimum, fitDistance, invalidate, size.height, size.width]);

  useEffect(() => {
    if (!command || !controls.current) return;
    if (command.action === 'preset') {
      const preset = presetFor(command.preset, fitDistance);
      camera.position.fromArray(preset.position);
      controls.current.target.fromArray(preset.target);
    } else {
      const target = controls.current.target;
      const offset = camera.position.clone().sub(target);
      const nextDistance = Math.min(distanceLimits.maximum, Math.max(distanceLimits.minimum, offset.length() * command.factor));
      offset.setLength(nextDistance);
      camera.position.copy(target).add(offset);
    }
    controls.current.update();
    invalidate();
  }, [command?.sequence, camera, invalidate]);

  return (
    <>
      {LIGHTS.map((light) => (
        <directionalLight key={light.name} ref={light.name === 'key' ? keyLight : undefined} name={`b2b-${light.name}`} position={light.position} intensity={light.intensity} />
      ))}
      <primitive object={gltf.scene} scale={scale} />
      <OrbitControls
        ref={controls}
        makeDefault
        enableDamping={false}
        enablePan
        enableZoom
        enableRotate
        zoomToCursor
        minDistance={distanceLimits.minimum}
        maxDistance={distanceLimits.maximum}
        mouseButtons={{
          LEFT: interactionMode === 'rotate' ? MOUSE.ROTATE : MOUSE.PAN,
          MIDDLE: MOUSE.DOLLY,
          RIGHT: MOUSE.PAN,
        }}
        touches={{
          ONE: interactionMode === 'rotate' ? TOUCH.ROTATE : TOUCH.PAN,
          TWO: TOUCH.DOLLY_PAN,
        }}
      />
    </>
  );
}

export function Viewer({
  gltf,
  scale,
  command,
  interactionMode,
  onContextLost,
  setProbe,
}: {
  gltf: GLTF;
  scale: number;
  command: CameraCommand;
  interactionMode: InteractionMode;
  onContextLost: () => void;
  setProbe: (probe: (() => object) | null) => void;
}) {
  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 2]}
      shadows={SHADOW_MAP}
      camera={{ position: presetFor('reset', distanceForScale(scale)).position, fov: 35, near: 0.01, far: 100 }}
      gl={{ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance', toneMapping: AgXToneMapping, toneMappingExposure: TONE_MAPPING_EXPOSURE }}
      onCreated={({ gl }) => {
        gl.domElement.dataset.testid = 'model-canvas';
        gl.domElement.tabIndex = 0;
        gl.domElement.setAttribute('aria-label', 'Interaktywny widok modelu 3D');
      }}
    >
      <Scene
        gltf={gltf}
        scale={scale}
        command={command}
        interactionMode={interactionMode}
        onContextLost={onContextLost}
        setProbe={setProbe}
      />
    </Canvas>
  );
}
