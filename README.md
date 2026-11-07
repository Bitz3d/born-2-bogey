# Born 2 Bogey — 3D scene

A public, static GitHub Pages site that shows the **Born 2 Bogey** diorama in 3D. The scene is a deadpan 1980s cop-show “bogey crime scene” with four figures, an Albatross basket with a turquoise +1, a white disc with the B2B logo, and the base with the logo.

The page has one viewport and one native **Wersja** select. The model downloads only after the visitor clicks **Uruchom 3D**. After that, changing the variant cancels any stale load, releases the previous scene and loads the new variant into the same viewport.

| Variant | Model ID | Figure textures | Download |
| --- | --- | --- | --- |
| Lekka — na telefon (default) | `born-2-bogey-light` | 2048 px | 82.8 MB |
| Pełna jakość — na komputer | `born-2-bogey-full` | 4096 px, as in the source scene | 148.1 MB |

Both variants have the same unsimplified geometry: 3,471,396 triangles.

Direct link to a variant: `https://bitz3d.github.io/born-2-bogey/?model=born-2-bogey-full`. Unknown IDs show a 404 message and download no model data.

## Publication boundary

- Only the two variants above and their preview image are published.
- `public/models.json` is the public catalog and the deployment allowlist. The validator fails closed if any of these hold:
  - `public/` contains an unlisted file;
  - a path escapes its folder;
  - a part, gzip or decoded hash or size differs;
  - a GLB needs any extension other than `EXT_meshopt_compression`;
  - the staged site exceeds 950 MB (GitHub Pages allows 1 GB).

## Assets

- Each variant is the **lossless** output of the workspace's shared figurine exporter: meshopt-compressed geometry whose decoded bytes are identical to the full-quality export, and unchanged texture bytes.
- Before encoding, a verified step gives every mesh primitive its own index accessor. Blender's glTF exporter shares identical index buffers, which the shared encoder does not accept.
- The light variant differs only in its figure textures. Base colour is 2048 px JPEG q90, and normals are 2048 px lossless PNG. Geometry and all other textures are unchanged.
- Each GLB is gzipped (level 9) and split into ordered parts below 50 MiB. The manifest records each part's URL, size and SHA-256, and the gzip and decoded GLB sizes and hashes.
- The browser verifies every part, the whole gzip and the decoded GLB before parsing it with three.js `GLTFLoader` plus `MeshoptDecoder`.
- Visitors can download the assets.

## Viewer look

The look is derived from the source Blender scene:

- the start view is the scene's front camera, and the 3/4 view uses the scene's quarter camera direction;
- AgX tone mapping, with the exposure calibrated against the approved Blender render;
- the uniform grey world becomes an image-based environment;
- the three area lights become directional lights from the same sides;
- the key light casts a soft VSM shadow;
- GTAO adds ambient occlusion;
- rendering runs at up to 2× the device pixel ratio, with anisotropic texture filtering.

Rendering is real-time, so it does not reproduce Cycles' light bounces.

## Local build with the existing pinned dependencies

No dependency installation is needed or intended. Link the existing dependency directory, build, lock and stage:

```bash
ln -s ../blender-agnet/projects/phoenix/delivery/web_v001/viewer-test/node_modules node_modules
node node_modules/vite/bin/vite.js build
python3 scripts/update_dist_lock.py
node --test scripts/catalog_navigation.test.mjs
python3 scripts/validate_and_stage.py --output _site   # refuses an existing output directory
```

`dist/` and `dist-files.json` are committed. `node_modules/` and `_site/` are not.

## Local verification

Serve the staged site on an unused loopback port:

```bash
python3 scripts/serve_local.py --root _site --port 5307
```

Then open `http://127.0.0.1:5307/born-2-bogey/`. The browser check uses an existing local Playwright installation and the installed headful Chrome; it installs nothing:

```bash
PLAYWRIGHT_PACKAGE=/path/to/existing/package.json node scripts/verify_browser.mjs \
  --url http://127.0.0.1:5307/born-2-bogey/ --out-dir /path/outside/this/repository/browser-run
```

The check:

- starts the default variant explicitly and switches to the other one with the select in the same session;
- verifies the decoded hashes;
- requires exact draw accounting: the scene triangles equal the manifest, and the rendered triangles equal the scene triangles plus those that three.js draws twice for transparent double-sided materials;
- requires the scene bounds to be inside the view;
- records errors and WebGL context loss;
- captures the reset and 3/4 views at device pixel ratio 2.

It runs on a desktop only. It is not a phone test. Keep its output outside this repository.

## Owner-only manual publication

- `.github/workflows/publish.yml` has only `workflow_dispatch`. The job requires all of these:
  - repository `Bitz3d/born-2-bogey`;
  - branch `main`;
  - both `github.actor` and `github.triggering_actor` equal to `Bitz3d`.
- It validates, stages `_site/` from the locked `dist/` and the manifest-listed `public/` files only, and deploys it to GitHub Pages.
- Pushing assets to this public repository makes them downloadable before any deployment.
