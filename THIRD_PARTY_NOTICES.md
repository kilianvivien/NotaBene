# Third-party notices

NotaBene is built on open-source software. Copyright remains with each project’s
contributors; this file is attribution, not a replacement for their licences.
The dependency packages contain their complete licence texts.

| Project                 | Licence                | Use                                  |
| ----------------------- | ---------------------- | ------------------------------------ |
| Tauri                   | Apache-2.0 / MIT       | Native application shell and plugins |
| React                   | MIT                    | Interface runtime                    |
| TipTap / ProseMirror    | MIT                    | Rich-text editing                    |
| Excalidraw              | MIT                    | Editable drawings                    |
| KaTeX                   | MIT                    | Mathematics rendering                |
| Tailwind CSS            | MIT                    | Styling toolchain                    |
| lucide-react            | ISC                    | Interface icons                      |
| pdfmake                 | MIT                    | PDF composition                      |
| docx                    | MIT                    | Word export                          |
| PDF.js (pdfjs-dist)     | Apache-2.0             | In-app PDF preview                   |
| docx-preview            | Apache-2.0             | In-app DOCX preview                  |
| AnyDoc                  | MIT                    | Local document import and conversion |
| i18next / react-i18next | MIT                    | Localization                         |
| Zustand and Immer       | MIT                    | Application state                    |
| Zod                     | MIT                    | Runtime schema validation            |
| fflate                  | MIT                    | Portable archive creation            |
| nanoid                  | MIT                    | Local entity identifiers             |
| wasm-media-encoders     | MIT                    | Local MP3 podcast encoding           |
| rusqlite / SQLite       | MIT / public domain    | Local persistence and search         |
| rmcp                    | Apache-2.0             | Local MCP server                     |
| axum / Tokio            | MIT                    | MCP transport and async runtime      |
| reqwest                 | Apache-2.0 / MIT       | AI provider transport                |
| rustls                  | Apache-2.0 / ISC / MIT | TLS for that transport               |
| CrispASR / GGML         | MIT                    | On-device neural speech runtime      |

The bundled Lora font is distributed under the SIL Open Font License 1.1. The
CrispASR/GGML runtime is built from source by
`scripts/prepare-crispasr-macos.sh` and staged into the bundle; its full notice
is shipped in `src-tauri/resources/notices/CrispASR-GGML.txt`.

## Optional on-device speech models

NotaBene bundles and redistributes no model weights. A user may explicitly
download either model, from a pinned revision verified against a recorded
SHA-256, after accepting its licence. The pins below are the ones recorded in
`src-tauri/resources/kokoro-model-manifest.json` and
`src-tauri/resources/voxtral-model-manifest.json`, which are authoritative.

**Kokoro 82M**

- Model: `cstr/kokoro-82m-GGUF`
- Revision: `f20291b3a27d0900af358ea1c87d63c76183b223`
- Licence: Apache-2.0
- Upstream model: `hexgrad/Kokoro-82M`

**Voxtral 4B**

- Model: `cstr/voxtral-4b-tts-GGUF`
- Revision: `a50d89a51997d49b8b3b55836aebf064c4a978e0`
- Licence: Creative Commons Attribution-NonCommercial 4.0 International
- Upstream model: `mistralai/Voxtral-4B-TTS-2603`

Voxtral's non-commercial restriction is presented to the user and must be
accepted before that model is installed.

NotaBene is an open-source, nonprofit project. This records the project's
intended non-commercial use and is not legal advice.
