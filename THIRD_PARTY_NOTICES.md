# Third-party notices

NotaBene is built on open-source software. Copyright remains with each project’s
contributors; this file is attribution, not a replacement for their licences.
The dependency packages contain their complete licence texts.

| Project | Licence | Use |
| --- | --- | --- |
| Tauri | Apache-2.0 / MIT | Native application shell and plugins |
| React | MIT | Interface runtime |
| TipTap / ProseMirror | MIT | Rich-text editing |
| Excalidraw | MIT | Editable drawings |
| KaTeX | MIT | Mathematics rendering |
| Tailwind CSS | MIT | Styling toolchain |
| lucide-react | ISC | Interface icons |
| pdfmake | MIT | PDF composition |
| docx | MIT | Word export |
| i18next / react-i18next | MIT | Localization |
| Zustand and Immer | MIT | Application state |
| Zod | MIT | Runtime schema validation |
| fflate | MIT | Portable archive creation |
| nanoid | MIT | Local entity identifiers |
| wasm-media-encoders | MIT | Local MP3 podcast encoding |
| rusqlite / SQLite | MIT / public domain | Local persistence and search |

The bundled Lora font is distributed under the SIL Open Font License 1.1.

## Optional Voxtral local speech

NotaBene does not bundle or redistribute Voxtral model weights. A user may
explicitly download the pinned MLX conversion from:

- Model: `mlx-community/Voxtral-4B-TTS-2603-mlx-4bit`
- Revision: `f98fc91b9cb5adc7dab56102c690458276c14c6a`
- License: Creative Commons Attribution-NonCommercial 4.0 International
- Upstream model: `mistralai/Voxtral-4B-TTS-2603`

The separately built worker uses `mlx-audio` 0.4.6 and the dependency versions
recorded in `sidecars/voxtral/uv.lock`. Release artifacts must include the
generated Python dependency license report and SBOM.

NotaBene is an open-source, nonprofit project. This records the project's
intended non-commercial use and is not legal advice.
