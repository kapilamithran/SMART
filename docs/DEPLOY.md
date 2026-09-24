# Deploying to GitHub Pages

1. Create a repository (e.g. `smart-scanner`) and upload **the contents of this folder** to its root, keeping `.nojekyll`.
   The largest file is `vendor/ort/ort-wasm-simd-threaded.jsep.wasm` (≈28 MB, used only by the optional WebGPU backend), which is under GitHub's 100 MB per-file limit.
   With git:
   ```bash
   git init && git add . && git commit -m "SMART (Scan, Mark, Audit, Review & Total)"
   git branch -M main && git remote add origin https://github.com/<you>/smart-scanner.git && git push -u origin main
   ```
2. Repository **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)`** → Save.
3. Open `https://<you>.github.io/smart-scanner/` in **Chrome or Brave on the phone**. HTTPS is required for the camera; GitHub Pages provides it.
4. First visit: the page reloads **once by itself**. The service worker adds the COOP/COEP headers that GitHub Pages cannot send, which makes the page cross-origin isolated and enables multithreaded WASM. Settings → Engine shows `isolated true` and the thread count.
5. Optional: browser menu → **Add to Home screen**. After the first load everything works offline.

**Updating:** change `VERSION` in `sw.js` on every deploy, otherwise phones keep the cached copy.

**Brave:** Shields do not block anything here (all files are same-origin). If the camera prompt does not appear, allow Camera under Site settings.
Brave may report a randomised `hardwareConcurrency`; the thread count shown in Settings is what is actually used.

**Privacy:** records and images live only in the phone's IndexedDB until you export. Do **not** commit real booklet photos
(`tests/photos/` is git-ignored). Clearing site data deletes all batches, so export before clearing.

**Local testing:** `python3 -m http.server 8080` in this folder, then open `http://localhost:8080` (localhost counts as a secure context).
To reach it from a phone on the same Wi-Fi you need HTTPS (e.g. `npx http-server -S` with a certificate, or just deploy to Pages).
