import { createRequire } from 'node:module';
import { dirname, join, posix } from 'node:path';

import { BadRequestException } from '@nestjs/common';
import type { TrainingSourceDocumentType } from '@prisma/client';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

import {
  TRAINING_DOCUMENT_EXTRACTION_TIMEOUT_MS,
  TRAINING_MAX_DOCUMENT_ENTRY_BYTES,
  TRAINING_MAX_DOCUMENT_UNCOMPRESSED_BYTES,
  TRAINING_MAX_DOCUMENT_ZIP_ENTRIES,
  TRAINING_MAX_EXTRACTED_CHARACTERS,
  TRAINING_MAX_EXTRACTION_SEGMENTS,
} from './training-document.config';

export type TrainingDocumentLocator =
  | { page: number }
  | { section: string; paragraph: number }
  | { slide: number }
  | { sheet: string; cell: string };

export type TrainingDocumentSegment = {
  locator: TrainingDocumentLocator;
  start: number;
  end: number;
};

export type TrainingDocumentExtraction = {
  text: string;
  segments: TrainingDocumentSegment[];
  truncated: boolean;
  needsManualText: boolean;
};

export interface TrainingDocumentExtractor {
  readonly type: TrainingSourceDocumentType;
  extract(buffer: Buffer): Promise<TrainingDocumentExtraction>;
}

export class TrainingDocumentExtractorRegistry {
  private readonly extractors: Map<TrainingSourceDocumentType, TrainingDocumentExtractor>;

  constructor() {
    const items: TrainingDocumentExtractor[] = [
      new PdfTrainingDocumentExtractor(),
      new DocxTrainingDocumentExtractor(),
      new PptxTrainingDocumentExtractor(),
      new XlsxTrainingDocumentExtractor(),
    ];
    this.extractors = new Map(items.map((extractor) => [extractor.type, extractor]));
  }

  async extract(type: TrainingSourceDocumentType, buffer: Buffer) {
    const extractor = this.extractors.get(type);

    if (!extractor) {
      throw new BadRequestException('Training document type is not supported');
    }

    return withTimeout(
      extractor.extract(buffer),
      TRAINING_DOCUMENT_EXTRACTION_TIMEOUT_MS,
      'Document text extraction timed out',
    );
  }
}

class PdfTrainingDocumentExtractor implements TrainingDocumentExtractor {
  readonly type = 'PDF' as const;

  async extract(buffer: Buffer) {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const packageDirectory = dirname(
      createRequire(__filename).resolve('pdfjs-dist/package.json'),
    );
    const loadingTask = getDocument({
      data: new Uint8Array(buffer),
      disableFontFace: true,
      standardFontDataUrl: `${join(packageDirectory, 'standard_fonts')}/`,
      useSystemFonts: false,
    });
    const accumulator = new ExtractionAccumulator();

    try {
      const document = await loadingTask.promise;

      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/\s+/gu, ' ')
          .trim();

        accumulator.append(text, { page: pageNumber });
        page.cleanup();
      }
    } finally {
      await loadingTask.destroy();
    }

    return accumulator.finish();
  }
}

class DocxTrainingDocumentExtractor implements TrainingDocumentExtractor {
  readonly type = 'DOCX' as const;

  async extract(buffer: Buffer) {
    const entries = await readSafeOoxmlEntries(buffer, (name) => name === 'word/document.xml');
    const documentXml = requireEntry(entries, 'word/document.xml', 'DOCX document.xml is missing');
    const parsed = parseXml(documentXml);
    const paragraphs = findTaggedNodes(parsed, 'p');
    const accumulator = new ExtractionAccumulator();
    let currentSection = 'Документ';

    paragraphs.forEach((paragraph, index) => {
      const text = collectTaggedText(paragraph, 't');
      const style = firstTaggedAttribute(paragraph, 'pStyle', 'val');

      if (/^Heading|^Заголовок/ui.test(style ?? '') && text) {
        currentSection = text;
      }

      accumulator.append(text, {
        section: currentSection,
        paragraph: index + 1,
      });
    });

    return accumulator.finish();
  }
}

class PptxTrainingDocumentExtractor implements TrainingDocumentExtractor {
  readonly type = 'PPTX' as const;

  async extract(buffer: Buffer) {
    const slidePattern = /^ppt\/slides\/slide(\d+)\.xml$/u;
    const entries = await readSafeOoxmlEntries(buffer, (name) => slidePattern.test(name));
    const slides = [...entries.entries()]
      .map(([name, value]) => ({
        number: Number(name.match(slidePattern)?.[1]),
        value,
      }))
      .filter((slide) => Number.isInteger(slide.number))
      .sort((left, right) => left.number - right.number);

    if (slides.length === 0) {
      throw new BadRequestException('PPTX contains no slides');
    }

    const accumulator = new ExtractionAccumulator();

    for (const slide of slides) {
      const parsed = parseXml(slide.value);
      const paragraphs = findTaggedNodes(parsed, 'p')
        .map((paragraph) => collectTaggedText(paragraph, 't'))
        .filter(Boolean);

      accumulator.append(paragraphs.join('\n'), { slide: slide.number });
    }

    return accumulator.finish();
  }
}

class XlsxTrainingDocumentExtractor implements TrainingDocumentExtractor {
  readonly type = 'XLSX' as const;

  async extract(buffer: Buffer) {
    const entries = await readSafeOoxmlEntries(
      buffer,
      (name) =>
        name === 'xl/workbook.xml' ||
        name === 'xl/_rels/workbook.xml.rels' ||
        name === 'xl/sharedStrings.xml' ||
        /^xl\/worksheets\/sheet\d+\.xml$/u.test(name),
    );
    const workbook = parseXml(
      requireEntry(entries, 'xl/workbook.xml', 'XLSX workbook.xml is missing'),
    );
    const relationships = entries.get('xl/_rels/workbook.xml.rels');
    const relationshipMap = relationships
      ? parseWorkbookRelationships(parseXml(relationships))
      : new Map<string, string>();
    const sharedStringsXml = entries.get('xl/sharedStrings.xml');
    const sharedStrings = sharedStringsXml
      ? findTaggedNodes(parseXml(sharedStringsXml), 'si').map((item) =>
          collectTaggedText(item, 't'),
        )
      : [];
    const sheets = findTaggedNodes(workbook, 'sheet');

    if (sheets.length === 0) {
      throw new BadRequestException('XLSX contains no worksheets');
    }

    const accumulator = new ExtractionAccumulator();

    sheets.forEach((sheet, sheetIndex) => {
      const name = readAttribute(sheet, 'name') || `Лист ${sheetIndex + 1}`;
      const relationId = readAttribute(sheet, 'id');
      const relationTarget = relationId ? relationshipMap.get(relationId) : undefined;
      const target = normalizeWorksheetTarget(relationTarget, sheetIndex + 1);
      const sheetXml = entries.get(target);

      if (!sheetXml) {
        return;
      }

      const cells = findTaggedNodes(parseXml(sheetXml), 'c');

      for (const cell of cells) {
        const reference = readAttribute(cell, 'r') || '?';
        const type = readAttribute(cell, 't');
        const hasFormula = containsTag(cell, 'f');

        if (hasFormula) {
          continue;
        }

        const value = collectCellValue(cell, type, sharedStrings);
        accumulator.append(value, { sheet: name, cell: reference });
      }
    });

    return accumulator.finish();
  }
}

class ExtractionAccumulator {
  private text = '';
  private readonly segments: TrainingDocumentSegment[] = [];
  private truncated = false;

  append(rawValue: string, locator: TrainingDocumentLocator) {
    if (this.truncated || this.segments.length >= TRAINING_MAX_EXTRACTION_SEGMENTS) {
      this.truncated = true;
      return;
    }

    const value = rawValue.replace(/\u0000/gu, '').replace(/[ \t]+/gu, ' ').trim();

    if (!value) {
      return;
    }

    const separator = this.text ? '\n\n' : '';
    const available =
      TRAINING_MAX_EXTRACTED_CHARACTERS - this.text.length - separator.length;

    if (available <= 0) {
      this.truncated = true;
      return;
    }

    const safeValue = value.slice(0, available);
    const start = this.text.length + separator.length;
    this.text += separator + safeValue;
    this.segments.push({ locator, start, end: start + safeValue.length });

    if (safeValue.length < value.length) {
      this.truncated = true;
    }
  }

  finish(): TrainingDocumentExtraction {
    return {
      text: this.text,
      segments: this.segments,
      truncated: this.truncated,
      needsManualText: this.text.trim().length === 0,
    };
  }
}

async function readSafeOoxmlEntries(
  buffer: Buffer,
  shouldCollect: (name: string) => boolean,
) {
  return new Promise<Map<string, Buffer>>((resolve, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, validateEntrySizes: true },
      (openError, zipFile) => {
        if (openError || !zipFile) {
          reject(new BadRequestException('Document is not a valid OOXML ZIP archive'));
          return;
        }

        const entries = new Map<string, Buffer>();
        let entryCount = 0;
        let totalUncompressedBytes = 0;
        let settled = false;

        const fail = (error: unknown) => {
          if (settled) return;
          settled = true;
          zipFile.close();
          const unsafePathError =
            error instanceof Error &&
            /invalid relative path|absolute path|backslash/iu.test(error.message);
          reject(
            error instanceof BadRequestException
              ? error
              : unsafePathError
                ? new BadRequestException('Document ZIP contains an unsafe path')
              : new BadRequestException('Cannot read OOXML document'),
          );
        };

        zipFile.on('error', fail);
        zipFile.on('end', () => {
          if (settled) return;
          settled = true;
          resolve(entries);
        });
        zipFile.on('entry', (entry: Entry) => {
          try {
            validateZipEntry(entry, ++entryCount);
            totalUncompressedBytes += entry.uncompressedSize;

            if (totalUncompressedBytes > TRAINING_MAX_DOCUMENT_UNCOMPRESSED_BYTES) {
              throw new BadRequestException('Document uncompressed size limit exceeded');
            }

            if (isRejectedOoxmlEntry(entry.fileName)) {
              throw new BadRequestException('Macros, embedded objects and external links are not allowed');
            }

            const collectEntry = shouldCollect(entry.fileName);
            const inspectEntry =
              collectEntry ||
              entry.fileName.endsWith('.rels') ||
              entry.fileName === '[Content_Types].xml';

            if (!inspectEntry) {
              zipFile.readEntry();
              return;
            }

            readZipEntry(zipFile, entry)
              .then((value) => {
                const xml = value.toString('utf8');
                if (/TargetMode\s*=\s*["']External["']/iu.test(xml)) {
                  throw new BadRequestException('External document relationships are not allowed');
                }
                if (/macroEnabled|vnd\.ms-office\.vbaProject/iu.test(xml)) {
                  throw new BadRequestException('Macro-enabled documents are not allowed');
                }
                if (collectEntry) {
                  entries.set(entry.fileName, value);
                }
                zipFile.readEntry();
              })
              .catch(fail);
          } catch (error) {
            fail(error);
          }
        });
        zipFile.readEntry();
      },
    );
  });
}

function validateZipEntry(entry: Entry, entryCount: number) {
  if (entryCount > TRAINING_MAX_DOCUMENT_ZIP_ENTRIES) {
    throw new BadRequestException('Document ZIP entry limit exceeded');
  }
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new BadRequestException('Encrypted documents are not supported');
  }
  if (entry.uncompressedSize > TRAINING_MAX_DOCUMENT_ENTRY_BYTES) {
    throw new BadRequestException('Document ZIP entry size limit exceeded');
  }
  if (
    entry.fileName.includes('\\') ||
    entry.fileName.startsWith('/') ||
    entry.fileName.split('/').includes('..')
  ) {
    throw new BadRequestException('Document ZIP contains an unsafe path');
  }
}

function isRejectedOoxmlEntry(name: string) {
  return /(^|\/)(vbaProject\.bin|activeX|externalLinks|embeddings|oleObject)/iu.test(name);
}

function readZipEntry(zipFile: ZipFile, entry: Entry) {
  return new Promise<Buffer>((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error('ZIP entry stream is missing'));
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > TRAINING_MAX_DOCUMENT_ENTRY_BYTES) {
          stream.destroy(new BadRequestException('Document ZIP entry size limit exceeded'));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}

function parseXml(value: Buffer) {
  const xml = value.toString('utf8');

  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw new BadRequestException('Document XML entities are not allowed');
  }

  const validation = XMLValidator.validate(xml, {
    allowBooleanAttributes: true,
  });

  if (validation !== true) {
    throw new BadRequestException('Document contains invalid XML');
  }

  return new XMLParser({
    allowBooleanAttributes: true,
    ignoreAttributes: false,
    parseAttributeValue: false,
    parseTagValue: false,
    processEntities: false,
    trimValues: false,
  }).parse(xml) as unknown;
}

function findTaggedNodes(value: unknown, suffix: string): Record<string, unknown>[] {
  const matches: Record<string, unknown>[] = [];

  if (Array.isArray(value)) {
    value.forEach((item) => matches.push(...findTaggedNodes(item, suffix)));
    return matches;
  }
  if (!isRecord(value)) {
    return matches;
  }

  for (const [key, child] of Object.entries(value)) {
    if (tagMatches(key, suffix)) {
      const values = Array.isArray(child) ? child : [child];
      values.filter(isRecord).forEach((item) => matches.push(item));
    } else {
      matches.push(...findTaggedNodes(child, suffix));
    }
  }

  return matches;
}

function collectTaggedText(value: unknown, suffix: string) {
  const parts: string[] = [];

  const visit = (current: unknown) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!isRecord(current)) {
      return;
    }

    for (const [key, child] of Object.entries(current)) {
      if (tagMatches(key, suffix)) {
        if (typeof child === 'string' || typeof child === 'number') {
          parts.push(String(child));
        } else if (Array.isArray(child)) {
          child.forEach((item) => {
            if (typeof item === 'string' || typeof item === 'number') {
              parts.push(String(item));
            } else if (isRecord(item) && typeof item['#text'] === 'string') {
              parts.push(item['#text']);
            }
          });
        } else if (isRecord(child) && typeof child['#text'] === 'string') {
          parts.push(child['#text']);
        }
      } else {
        visit(child);
      }
    }
  };

  visit(value);
  return parts.join(' ').replace(/\s+/gu, ' ').trim();
}

function containsTag(value: unknown, suffix: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsTag(item, suffix));
  }
  if (!isRecord(value)) {
    return false;
  }

  return Object.entries(value).some(
    ([key, child]) => tagMatches(key, suffix) || containsTag(child, suffix),
  );
}

function firstTaggedAttribute(value: unknown, tag: string, attribute: string) {
  return readAttribute(findTaggedNodes(value, tag)[0], attribute) || null;
}

function readAttribute(value: unknown, name: string) {
  if (!isRecord(value)) return '';

  for (const [key, child] of Object.entries(value)) {
    if (key === `@_${name}` || key.endsWith(`:${name}`)) {
      return typeof child === 'string' || typeof child === 'number' ? String(child) : '';
    }
  }

  return '';
}

function parseWorkbookRelationships(value: unknown) {
  const result = new Map<string, string>();

  for (const relationship of findTaggedNodes(value, 'Relationship')) {
    const id = readAttribute(relationship, 'Id');
    const target = readAttribute(relationship, 'Target');

    if (id && target && !target.startsWith('/') && !target.includes('..')) {
      result.set(id, target);
    }
  }

  return result;
}

function normalizeWorksheetTarget(value: string | undefined, index: number) {
  if (!value) {
    return `xl/worksheets/sheet${index}.xml`;
  }

  return value.startsWith('xl/') ? posix.normalize(value) : posix.normalize(`xl/${value}`);
}

function collectCellValue(cell: Record<string, unknown>, type: string, sharedStrings: string[]) {
  if (type === 'inlineStr') {
    return collectTaggedText(cell, 't');
  }

  const rawValue = collectTaggedText(cell, 'v');

  if (type === 's') {
    const index = Number(rawValue);
    return Number.isInteger(index) ? sharedStrings[index] ?? '' : '';
  }
  if (type === 'b') {
    return rawValue === '1' ? 'Да' : rawValue === '0' ? 'Нет' : rawValue;
  }

  return rawValue;
}

function requireEntry(entries: Map<string, Buffer>, name: string, message: string) {
  const value = entries.get(name);

  if (!value) {
    throw new BadRequestException(message);
  }

  return value;
}

function tagMatches(key: string, suffix: string) {
  return key === suffix || key.endsWith(`:${suffix}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(message)), milliseconds);
    timeout.unref();
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
