import { randomUUID } from 'node:crypto';

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  Prisma,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingSourceExtractionStatus,
} from '@prisma/client';

import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { TRAINING_DOCUMENT_JOB_POLL_MS } from './training-document.config';
import { TrainingDocumentExtractorRegistry } from './training-document-extractor';

@Injectable()
export class TrainingDocumentWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(TrainingDocumentWorkerService.name);
  private readonly workerId = `training-document:${process.pid}:${randomUUID()}`;
  private readonly extractors = new TrainingDocumentExtractorRegistry();
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private kickQueued = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  onModuleInit() {
    this.interval = setInterval(() => this.kick(), TRAINING_DOCUMENT_JOB_POLL_MS);
    this.interval.unref();
    this.kick();
  }

  onModuleDestroy() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  kick() {
    if (this.running || this.kickQueued) return;
    this.kickQueued = true;
    queueMicrotask(() => {
      this.kickQueued = false;
      void this.drain();
    });
  }

  private async drain() {
    if (this.running) return;
    this.running = true;

    try {
      while (await this.processNext()) {
        // Drain all currently runnable extraction jobs.
      }
    } catch (error) {
      this.logger.error(
        'Training document worker loop failed',
        error instanceof Error ? error.stack : String(error),
      );
    } finally {
      this.running = false;
    }
  }

  private async processNext() {
    const candidate = await this.prisma.trainingJob.findFirst({
      where: {
        kind: TrainingJobKind.EXTRACT_SOURCE_DOCUMENT,
        status: TrainingJobStatus.PENDING,
        runAt: { lte: new Date() },
      },
      orderBy: [{ runAt: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        payloadJson: true,
        attempts: true,
        maxAttempts: true,
      },
    });

    if (!candidate) {
      return false;
    }

    const claimed = await this.prisma.trainingJob.updateMany({
      where: {
        id: candidate.id,
        status: TrainingJobStatus.PENDING,
      },
      data: {
        status: TrainingJobStatus.RUNNING,
        attempts: { increment: 1 },
        lockOwner: this.workerId,
        lockedAt: new Date(),
        heartbeatAt: new Date(),
      },
    });

    if (claimed.count === 0) {
      return true;
    }

    await this.processClaimed(candidate);
    return true;
  }

  private async processClaimed(job: {
    id: string;
    payloadJson: Prisma.JsonValue;
    attempts: number;
    maxAttempts: number;
  }) {
    const sourceDocumentId = readSourceDocumentId(job.payloadJson);

    try {
      if (!sourceDocumentId) {
        throw new Error('Extraction job payload has no sourceDocumentId');
      }

      const document = await this.prisma.trainingSourceDocument.findUnique({
        where: { id: sourceDocumentId },
        include: { file: true },
      });

      if (!document) {
        throw new Error('Training source document no longer exists');
      }

      await this.prisma.trainingSourceDocument.update({
        where: { id: document.id },
        data: {
          extractionStatus: TrainingSourceExtractionStatus.PROCESSING,
          errorMessage: null,
        },
      });

      const buffer = await this.files.readStoredFile(document.file);
      const extraction = await this.extractors.extract(document.documentType, buffer);
      const status = extraction.needsManualText
        ? TrainingSourceExtractionStatus.NEEDS_MANUAL_TEXT
        : TrainingSourceExtractionStatus.READY;

      await this.prisma.$transaction([
        this.prisma.trainingSourceDocument.update({
          where: { id: document.id },
          data: {
            extractionStatus: status,
            extractedText: extraction.text || null,
            extractionMetadataJson: {
              source: 'automatic',
              segments: extraction.segments,
              truncated: extraction.truncated,
              scoringEligible: false,
            },
            errorMessage: null,
          },
        }),
        this.prisma.trainingJob.update({
          where: { id: job.id },
          data: {
            status: TrainingJobStatus.SUCCEEDED,
            finishedAt: new Date(),
            lockOwner: null,
            lockedAt: null,
            heartbeatAt: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            errorDetailsJson: Prisma.JsonNull,
          },
        }),
      ]);
    } catch (error) {
      await this.failJob(job, sourceDocumentId, error);
    }
  }

  private async failJob(
    job: { id: string; attempts: number; maxAttempts: number },
    sourceDocumentId: string | null,
    error: unknown,
  ) {
    const nextAttempt = job.attempts + 1;
    const shouldRetry = nextAttempt < job.maxAttempts;
    const message = toSafeErrorMessage(error);

    const operations: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.trainingJob.update({
        where: { id: job.id },
        data: {
          status: shouldRetry ? TrainingJobStatus.PENDING : TrainingJobStatus.DEAD,
          runAt: shouldRetry
            ? new Date(Date.now() + nextAttempt * 2_000)
            : undefined,
          finishedAt: shouldRetry ? null : new Date(),
          lockOwner: null,
          lockedAt: null,
          heartbeatAt: null,
          lastErrorCode: 'DOCUMENT_EXTRACTION_FAILED',
          lastErrorMessage: message,
          errorDetailsJson: { retryable: shouldRetry },
        },
      }),
    ];

    if (sourceDocumentId) {
      operations.push(
        this.prisma.trainingSourceDocument.updateMany({
          where: { id: sourceDocumentId },
          data: {
            extractionStatus: shouldRetry
              ? TrainingSourceExtractionStatus.PENDING
              : TrainingSourceExtractionStatus.FAILED,
            errorMessage: message,
          },
        }),
      );
    }

    await this.prisma.$transaction(operations);
    this.logger.warn(`Document extraction job ${job.id} failed: ${message}`);
  }
}

function readSourceDocumentId(value: Prisma.JsonValue) {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof value.sourceDocumentId !== 'string'
  ) {
    return null;
  }

  return value.sourceDocumentId;
}

function toSafeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : 'Document extraction failed';

  return message.replace(/[\r\n]+/gu, ' ').slice(0, 2_000);
}
