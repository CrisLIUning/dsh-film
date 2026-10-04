# Licence texts the bundled apps need but their packages do not ship

`node scripts/build-apps.mjs notices editor` copies these files into
`apps/editor/licenses/` and points `apps/editor/THIRD-PARTY-NOTICES.txt` at them.
They are kept here, not in `apps/`, because `apps/` is rebuilt from the sibling
checkouts and the notices step works offline. This folder is not in the npm
package; only the copies under `apps/` are.

Every file is the upstream text unchanged (line endings LF), fetched on
2026-10-04. SHA-256 is of the file as stored here.

| File | For | Source | SHA-256 |
| --- | --- | --- | --- |
| `LGPL-2.1.txt` | FFmpeg in the custom libav.js build and in `@mediabunny/aac-encoder`; libav.js | https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt | `20e50fe7aae3e56378ebf0417d9de904f55a0e61e4df315333e632a4d3555d95` |
| `Apache-2.0.txt` | `@mediapipe/tasks-vision`, `vendor/mediapipe/vision`, TensorFlow.js in `vendor/vocal-remover`, OpenCV 4.5 and later | https://www.apache.org/licenses/LICENSE-2.0.txt (byte-identical to https://raw.githubusercontent.com/opencv/opencv/4.5.5/LICENSE) | `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30` |
| `onnxruntime-LICENSE.txt` | `onnxruntime-web`, `onnxruntime-common`, `onnxruntime-node` (their npm packages carry no licence file) | https://raw.githubusercontent.com/microsoft/onnxruntime/v1.27.0/LICENSE (identical at v1.16.3, v1.18.0 and 89f8206ba4) | `2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c` |
| `onnxruntime-ThirdPartyNotices-v1.27.0.txt` | the same, newest version in the editor's lockfile | https://raw.githubusercontent.com/microsoft/onnxruntime/v1.27.0/ThirdPartyNotices.txt | `0e07b95f3a8d6230037707c5c4a2b554d12c4cb67369669ac255635528ffcee2` |
| `onnxruntime-ThirdPartyNotices-older-versions.txt` | the sections of the older versions' notices whose component v1.27.0 no longer lists (HalideIR, TVM, google/nsync, composable_kernel) | extracted from https://raw.githubusercontent.com/microsoft/onnxruntime/v1.16.3/ThirdPartyNotices.txt, `.../v1.18.0/...` and `.../89f8206ba4/...` (the commit of 1.22.0-dev.20250409-89f8206ba4): every section after a `_____` line whose first line is not a section title in v1.27.0, text unchanged, each preceded by a bracketed line naming the versions it comes from | `69d07e3356b3a29c7053d5e18b67c6eb9dc317dceb3251880664d2d2c1ada29b` |
| `mediapipe-v1.0.0-LICENSE.txt` | `@mediapipe/tasks-vision` 1.0.0 and `vendor/mediapipe/vision` | https://raw.githubusercontent.com/google-ai-edge/mediapipe/v1.0.0/LICENSE (Apache-2.0 plus MediaPipe's third-party notices) | `8707eef0533987efc5b155d64761eeb6e20793f50b9bd1a68dad1cf4719d0ed8` |
| `opencv-4.4.0-LICENSE.txt` | `vendor/opencv.js` if it were OpenCV before 4.5 (3-clause BSD, with the copyright holders) | https://raw.githubusercontent.com/opencv/opencv/4.4.0/LICENSE | `a5a7cf90fe5ac9763baad852cf69cf9d9b89bff934a679fdc5c8fcecaeba9a25` |
| `opencv-4.5.5-COPYRIGHT.txt` | `vendor/opencv.js` (its compiled build information reads OpenCV 4.5.5): the copyright holders that go with Apache-2.0 | https://raw.githubusercontent.com/opencv/opencv/4.5.5/COPYRIGHT | `6643d7f8663a49cb31d6561875231c8921f17369644e164d6c4de2be2b90f405` |

When the editor's lockfile moves to a newer `onnxruntime-web`, the notices step
stops until `onnxruntime-ThirdPartyNotices-v<version>.txt` for that version is
added here (from the release tag `v<version>` of
https://github.com/microsoft/onnxruntime) and `ONNXRUNTIME_NOTICES` in
`scripts/build-apps.mjs` names it.
