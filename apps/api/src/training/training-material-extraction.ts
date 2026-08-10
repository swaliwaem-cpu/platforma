import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { BadRequestException, Injectable, RequestTimeoutException } from '@nestjs/common';
import type { TrainingMaterialSegment } from '@platforma/shared' with { 'resolution-mode': 'import' };

export const TRAINING_MATERIAL_PDF_PAGE_LIMIT = 200;
const DEFAULT_MAX_TEXT_CHARS = 2_000_000;
const MAX_CONFIGURED_TEXT_CHARS = 5_000_000;

export type TrainingMaterialExtraction = {
  text: string;
  segments: TrainingMaterialSegment[];
  contentHash: string;
  metadata: Record<string, unknown>;
};

export type TrainingMaterialDiffValue = {
  previousRevisionId: string | null;
  added: string[];
  removed: string[];
  unchangedCount: number;
  changed: boolean;
};

@Injectable()
export class TrainingMaterialExtractionService {
  extractManual(text: string): TrainingMaterialExtraction {
    const normalized = normalizeTrainingMaterialText(text);
    if (!normalized) throw new BadRequestException('MATERIAL_TEXT_EMPTY');

    const segments = segmentParagraphs(normalized);
    return this.complete(segments, { method: 'MANUAL' });
  }

  async extractPdf(buffer: Buffer): Promise<TrainingMaterialExtraction> {
    const timeoutMs = readBoundedInteger(
      'TRAINING_MATERIAL_EXTRACTION_TIMEOUT_MS',
      60_000,
      1_000,
      180_000,
    );

    return withTimeout(this.extractPdfWithinDeadline(buffer), timeoutMs, 'PDF_EXTRACTION_TIMEOUT');
  }

  async extractPdfFile(filePath: string): Promise<TrainingMaterialExtraction> {
    const timeoutMs = readBoundedInteger(
      'TRAINING_MATERIAL_EXTRACTION_TIMEOUT_MS',
      60_000,
      1_000,
      180_000,
    );

    return withTimeout(
      this.extractPdfWithinDeadline(pathToFileURL(filePath)),
      timeoutMs,
      'PDF_EXTRACTION_TIMEOUT',
    );
  }

  complete(
    segments: TrainingMaterialSegment[],
    metadata: Record<string, unknown>,
  ): TrainingMaterialExtraction {
    const boundedSegments = boundSegments(segments);
    if (!boundedSegments.length) throw new BadRequestException('MATERIAL_TEXT_EMPTY');
    const text = boundedSegments.map((segment) => segment.text).join('\n\n');

    return {
      text,
      segments: boundedSegments,
      contentHash: createHash('sha256').update(text).digest('hex'),
      metadata,
    };
  }

  private async extractPdfWithinDeadline(source: Buffer | URL): Promise<TrainingMaterialExtraction> {
    let loadingTask: { destroy(): Promise<void> } | null = null;

    try {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const task = pdfjs.getDocument({
        ...(Buffer.isBuffer(source)
          ? { data: new Uint8Array(source) }
          : { url: source }),
        useSystemFonts: true,
      });
      loadingTask = task;
      const document = await task.promise;
      if (document.numPages < 1 || document.numPages > TRAINING_MATERIAL_PDF_PAGE_LIMIT) {
        throw new BadRequestException('PDF_PAGE_LIMIT_EXCEEDED');
      }

      const segments: TrainingMaterialSegment[] = [];
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const content = await page.getTextContent();
        const text = normalizeTrainingMaterialText(
          content.items
            .map((item) => isPdfTextItem(item) ? item.str : '')
            .filter(Boolean)
            .join(' '),
        );
        if (text) {
          segments.push({
            locator: `page:${pageNumber}`,
            label: `Страница ${pageNumber}`,
            text,
          });
        }
      }

      if (!segments.length) throw new BadRequestException('PDF_TEXT_LAYER_MISSING');
      return this.complete(segments, { method: 'PDF_TEXT_LAYER', pageCount: document.numPages });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message.toLocaleLowerCase('en-US') : '';
      if (message.includes('password')) throw new BadRequestException('PDF_PASSWORD_PROTECTED');
      throw new BadRequestException('PDF_INVALID');
    } finally {
      await loadingTask?.destroy().catch(() => undefined);
    }
  }
}

export function normalizeTrainingMaterialText(value: string) {
  return value
    .normalize('NFC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\t\f\v ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export function normalizeTrainingEvidenceText(value: string) {
  return normalizeTrainingMaterialText(value).replace(/\s+/gu, ' ');
}

export function normalizeTrainingEvidence(value: string) {
  return normalizeTrainingEvidenceText(value).toLocaleLowerCase('ru-RU');
}

export function isExactSegmentExcerpt(
  segments: readonly TrainingMaterialSegment[],
  locator: string,
  excerpt: string,
) {
  const segment = segments.find((item) => item.locator === locator);
  const normalizedExcerpt = normalizeTrainingEvidence(excerpt);
  return Boolean(
    segment && normalizedExcerpt && normalizeTrainingEvidence(segment.text).includes(normalizedExcerpt),
  );
}

export function createTrainingMaterialDiff(
  previousRevisionId: string | null,
  previousSegments: readonly TrainingMaterialSegment[],
  nextSegments: readonly TrainingMaterialSegment[],
): TrainingMaterialDiffValue {
  const previous = new Map(previousSegments.map((segment) => [segmentIdentity(segment), segment]));
  const next = new Map(nextSegments.map((segment) => [segmentIdentity(segment), segment]));
  const added = [...next]
    .filter(([identity]) => !previous.has(identity))
    .slice(0, 100)
    .map(([, segment]) => segmentPreview(segment));
  const removed = [...previous]
    .filter(([identity]) => !next.has(identity))
    .slice(0, 100)
    .map(([, segment]) => segmentPreview(segment));
  const unchangedCount = [...next.keys()].filter((identity) => previous.has(identity)).length;

  return {
    previousRevisionId,
    added,
    removed,
    unchangedCount,
    changed: previousRevisionId === null || added.length > 0 || removed.length > 0,
  };
}

export function parseStoredSegments(value: unknown): TrainingMaterialSegment[] {
  if (!Array.isArray(value)) throw new BadRequestException('MATERIAL_SEGMENTS_INVALID');

  const segments = value.map((segment) => {
    if (
      typeof segment !== 'object' || segment === null || Array.isArray(segment) ||
      typeof (segment as Record<string, unknown>).locator !== 'string' ||
      typeof (segment as Record<string, unknown>).label !== 'string' ||
      typeof (segment as Record<string, unknown>).text !== 'string'
    ) {
      throw new BadRequestException('MATERIAL_SEGMENTS_INVALID');
    }
    const record = segment as { locator: string; label: string; text: string };
    return { locator: record.locator, label: record.label, text: record.text };
  });

  return boundSegments(segments);
}

function segmentParagraphs(text: string) {
  return text.split(/\n{2,}/u).map((paragraph, index) => ({
    locator: `paragraph:${index + 1}`,
    label: `Абзац ${index + 1}`,
    text: paragraph,
  }));
}

function boundSegments(segments: readonly TrainingMaterialSegment[]) {
  const maxChars = readBoundedInteger(
    'TRAINING_MATERIAL_MAX_TEXT_CHARS',
    DEFAULT_MAX_TEXT_CHARS,
    10_000,
    MAX_CONFIGURED_TEXT_CHARS,
  );
  const result: TrainingMaterialSegment[] = [];
  const locators = new Set<string>();
  let used = 0;

  for (const segment of segments) {
    const locator = segment.locator.normalize('NFC').trim();
    const label = normalizeTrainingMaterialText(segment.label);
    const text = normalizeTrainingMaterialText(segment.text);
    if (!locator || locator.length > 240 || !label || label.length > 240 || !text || locators.has(locator)) continue;
    if (used + text.length > maxChars) throw new BadRequestException('MATERIAL_TEXT_LIMIT_EXCEEDED');
    result.push({ locator, label, text });
    locators.add(locator);
    used += text.length;
  }
  return result;
}

function segmentIdentity(segment: TrainingMaterialSegment) {
  return `${segment.locator}\n${normalizeTrainingMaterialText(segment.text)}`;
}

function segmentPreview(segment: TrainingMaterialSegment) {
  const text = normalizeTrainingMaterialText(segment.text);
  const bounded = text.length > 500 ? `${text.slice(0, 497)}...` : text;
  return `${segment.label}: ${bounded}`;
}

function isPdfTextItem(value: unknown): value is { str: string } {
  return typeof value === 'object' && value !== null && 'str' in value &&
    typeof (value as { str?: unknown }).str === 'string';
}

function readBoundedInteger(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, code: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RequestTimeoutException(code)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
