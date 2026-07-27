import { strToU8, zipSync } from 'fflate';
import { assets, dialog, exporter, library, type ExportFormat } from '@/lib/adapters';
import { docToMarkdown } from '@/editor/markdown';
import { completeHtmlDocument, docToSemanticHtml, htmlText } from '@/lib/export/render';
import { notesToDocx } from '@/lib/export/docx';
import type { Course, DocNode, Note, Tag } from '@/lib/schema';
import { fail, ok, type CommandResult } from './types';

export interface NoteExportOptions {
  format: Exclude<ExportFormat, 'backup'>;
  layout: 'combined' | 'separate';
  includeToc: boolean;
  language?: string;
  /** Explicit output path for non-interactive callers such as MCP. When
   * omitted, the UI owns destination selection through the save panel. */
  destination?: string;
}

function slug(value: string, fallback: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .toLocaleLowerCase();
  return cleaned || fallback;
}

function extensionFor(mime: string): string {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/svg+xml') return 'svg';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'application/pdf') return 'pdf';
  return mime.startsWith('image/') ? 'jpg' : 'bin';
}

function collectAssetIds(nodes: DocNode[], result = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.type === 'image' && typeof node.attrs?.assetId === 'string') {
      result.add(node.attrs.assetId);
    }
    collectAssetIds(node.content ?? [], result);
  }
  return result;
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result)), { once: true });
    reader.addEventListener('error', () => reject(reader.error), { once: true });
    reader.readAsDataURL(blob);
  });
}

async function loadAssets(notes: Note[]) {
  const ids = collectAssetIds(notes.flatMap((note) => note.doc.content));
  const blobs = new Map<string, Blob>();
  for (const id of ids) {
    const blob = await assets.get(id);
    if (blob) blobs.set(id, blob);
  }
  return blobs;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function markdownBody(
  note: Note,
  assetBlobs: ReadonlyMap<string, Blob>,
): { markdown: string; drawings: Map<string, Blob> } {
  const chunks: string[] = [];
  const drawings = new Map<string, Blob>();
  for (const [index, node] of note.doc.content.entries()) {
    if (node.type === 'drawing' && typeof node.attrs?.svg === 'string') {
      const path = `assets/drawing-${slug(note.title, note.id)}-${index + 1}.svg`;
      drawings.set(path, new Blob([node.attrs.svg], { type: 'image/svg+xml' }));
      chunks.push(`![${String(node.attrs?.title ?? 'Drawing')}](${path})`);
      continue;
    }
    let markdown = docToMarkdown({ type: 'doc', content: [node] });
    markdown = markdown.replaceAll(/asset:([a-zA-Z0-9]+)/g, (_match, id: string) => {
      const blob = assetBlobs.get(id);
      return `assets/${id}.${extensionFor(blob?.type ?? 'application/octet-stream')}`;
    });
    if (markdown) chunks.push(markdown);
  }
  return { markdown: chunks.join('\n\n'), drawings };
}

function frontmatter(note: Note, courses: Course[], tags: Tag[]): string {
  const course = courses.find((entry) => entry.id === note.courseId);
  const names = tags
    .filter((entry) => note.tagIds.includes(entry.id))
    .map((entry) => `${entry.namespace ? `${entry.namespace}:` : ''}${entry.name}`);
  return [
    '---',
    `title: ${yamlString(note.title)}`,
    `course: ${yamlString(course?.name ?? '')}`,
    `tags: [${names.map(yamlString).join(', ')}]`,
    `created: ${yamlString(note.createdAt)}`,
    `updated: ${yamlString(note.updatedAt)}`,
    '---',
    '',
  ].join('\n');
}

async function zipFiles(files: Map<string, Blob>): Promise<Blob> {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, blob] of files) {
    entries[path] = new Uint8Array(await blob.arrayBuffer());
  }
  return new Blob([zipSync(entries, { level: 6 })], { type: 'application/zip' });
}

function notePath(note: Note, courses: Course[], extension: string): string {
  const course = courses.find((entry) => entry.id === note.courseId);
  const folder = course ? slug(course.name, course.id) : 'inbox';
  return `${folder}/${slug(note.title, note.id)}.${extension}`;
}

export async function exportNotesCommand(
  noteIds: string[],
  options: NoteExportOptions,
): Promise<CommandResult<string | undefined>> {
  const notes = (
    await Promise.all([...new Set(noteIds)].map((id) => library.getNote(id)))
  ).filter((note): note is Note => note !== null);
  if (!notes.length) return fail('not_found', 'No notes selected for export');

  try {
    const exportedLibrary = await library.exportLibrary();
    const courses = exportedLibrary.courses;
    const tags = exportedLibrary.tags;
    const assetBlobs = await loadAssets(notes);
    const baseName =
      notes.length === 1 ? slug(notes[0]?.title ?? '', notes[0]?.id ?? 'note') : 'notes';

    if (options.format === 'pdf') {
      const { notesToPdf } = await import('@/lib/export/pdf');
      const urls = new Map<string, string>();
      for (const [id, blob] of assetBlobs) urls.set(id, await blobDataUrl(blob));
      const metadata = new Map(
        notes.map((note) => [
          note.id,
          {
            course: courses.find((course) => course.id === note.courseId)?.name,
            updated: new Date(note.updatedAt).toLocaleDateString(options.language),
          },
        ]),
      );
      const contents = await notesToPdf(notes, urls, metadata, {
        includeToc: options.includeToc,
        language: options.language,
      });
      const name = `${baseName}.pdf`;
      const destination =
        options.destination ??
        (await dialog.saveFile({
          defaultPath: name,
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        }));
      if (!destination) return fail('not_supported', 'Export cancelled');
      const result = await exporter.write({
        format: 'pdf',
        destination,
        suggestedName: name,
        files: [{ path: name, contents }],
      });
      return result.ok
        ? ok(result.path)
        : fail('storage_failed', result.error ?? 'PDF export failed');
    }

    const files = new Map<string, Blob>();
    if (options.format === 'markdown') {
      const combined: string[] = [];
      for (const note of notes) {
        const body = markdownBody(note, assetBlobs);
        const text = `${frontmatter(note, courses, tags)}${body.markdown}\n`;
        if (options.layout === 'combined') {
          combined.push(`# ${note.title || 'Untitled note'}\n\n${text}`);
        } else {
          files.set(
            notePath(note, courses, 'md'),
            new Blob([text], { type: 'text/markdown;charset=utf-8' }),
          );
        }
        for (const [path, blob] of body.drawings) files.set(path, blob);
      }
      if (options.layout === 'combined') {
        files.set(
          `${baseName}.md`,
          new Blob([combined.join('\n\n---\n\n')], {
            type: 'text/markdown;charset=utf-8',
          }),
        );
      }
      for (const [id, blob] of assetBlobs) {
        files.set(`assets/${id}.${extensionFor(blob.type)}`, blob);
      }
    } else if (options.format === 'html') {
      const urls = new Map<string, string>();
      for (const [id, blob] of assetBlobs) urls.set(id, await blobDataUrl(blob));
      if (options.layout === 'combined') {
        const body = notes
          .map(
            (note) =>
              `<article class="note" id="note-${htmlText(note.id)}"><h1>${htmlText(note.title || 'Untitled note')}</h1>${docToSemanticHtml(note.doc, urls)}</article>`,
          )
          .join('');
        const toc =
          options.includeToc && notes.length > 1
            ? `<nav class="toc"><h1>Contents</h1><ol>${notes.map((note) => `<li><a href="#note-${htmlText(note.id)}">${htmlText(note.title || 'Untitled note')}</a></li>`).join('')}</ol></nav>`
            : undefined;
        files.set(
          `${baseName}.html`,
          new Blob(
            [
              completeHtmlDocument(baseName, body, {
                toc,
                language: options.language,
              }),
            ],
            { type: 'text/html;charset=utf-8' },
          ),
        );
      } else {
        for (const note of notes) {
          files.set(
            notePath(note, courses, 'html'),
            new Blob(
              [
                completeHtmlDocument(
                  note.title,
                  `<article><h1>${htmlText(note.title)}</h1>${docToSemanticHtml(note.doc, urls)}</article>`,
                  { language: options.language },
                ),
              ],
              { type: 'text/html;charset=utf-8' },
            ),
          );
        }
      }
    } else {
      const data = new Map<string, { bytes: Uint8Array; mime: string }>();
      for (const [id, blob] of assetBlobs) {
        data.set(id, {
          bytes: new Uint8Array(await blob.arrayBuffer()),
          mime: blob.type,
        });
      }
      if (options.layout === 'combined') {
        files.set(`${baseName}.docx`, await notesToDocx(notes, data));
      } else {
        for (const note of notes) {
          files.set(notePath(note, courses, 'docx'), await notesToDocx([note], data));
        }
      }
    }

    const packageAsZip = files.size > 1;
    const contents = packageAsZip
      ? await zipFiles(files)
      : (files.values().next().value ??
        new Blob([strToU8('')], { type: 'application/octet-stream' }));
    const name = packageAsZip
      ? `${baseName}.zip`
      : (files.keys().next().value ?? baseName);
    const destination =
      options.destination ??
      (await dialog.saveFile({
        defaultPath: name,
        filters: [
          {
            name: options.format.toUpperCase(),
            extensions: [
              packageAsZip
                ? 'zip'
                : options.format === 'markdown'
                  ? 'md'
                  : options.format,
            ],
          },
        ],
      }));
    if (!destination) return fail('not_supported', 'Export cancelled');
    const result = await exporter.write({
      format: options.format,
      destination,
      suggestedName: name,
      files: [{ path: name, contents }],
    });
    return result.ok
      ? ok(result.path)
      : fail('storage_failed', result.error ?? 'Export failed');
  } catch (error) {
    return fail('storage_failed', error instanceof Error ? error.message : String(error));
  }
}
