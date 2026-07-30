import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TrainingFactSuggestionRunStatus,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingProjectStatus,
  TrainingSourceExtractionStatus,
  TrainingVersionStatus,
} from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import type { TrainingAuditRequest } from './training-content.service';
import {
  TrainingOfficialUrlFetchError,
  normalizeOfficialHostname,
  normalizeOfficialUrl,
} from './training-official-url-fetcher';
import { lockTrainingVersionForContentMutation } from './training-version-lock';

export const TRAINING_MAX_OFFICIAL_URL_SOURCES_PER_VERSION = 50;

const officialUrlSourceInclude = {
  snapshotFile: {
    select: {
      id: true,
      bucket: true,
      key: true,
      originalName: true,
      mimeType: true,
      sizeBytes: true,
      createdAt: true,
    },
  },
  _count: {
    select: {
      facts: true,
    },
  },
} satisfies Prisma.TrainingOfficialUrlSourceInclude;

type OfficialUrlSourceRecord =
  Prisma.TrainingOfficialUrlSourceGetPayload<{
    include: typeof officialUrlSourceInclude;
  }>;

@Injectable()
export class TrainingOfficialUrlSourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  async listSources(versionIdInput: string) {
    const version = await this.requireVersion(versionIdInput);
    const sources = await this.prisma.trainingOfficialUrlSource.findMany({
      where: { projectVersionId: version.id },
      orderBy: { createdAt: 'asc' },
      include: officialUrlSourceInclude,
    });

    return { items: sources.map((source) => this.serializeSource(source)) };
  }

  async createSource(
    versionIdInput: string,
    body: Record<string, unknown>,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    this.assertOnlyFields(body, ['url', 'confirmedOfficialHost']);
    const version = await this.requireDraftVersion(versionIdInput);
    if (
      typeof body.url !== 'string' ||
      typeof body.confirmedOfficialHost !== 'string'
    ) {
      throw new BadRequestException(
        'URL and confirmed official host are required',
      );
    }

    const inputUrl = body.url;
    let normalizedUrl: URL;
    let confirmedOfficialHost: string;
    try {
      normalizedUrl = normalizeOfficialUrl(inputUrl);
      confirmedOfficialHost = normalizeOfficialHostname(
        body.confirmedOfficialHost,
      );
    } catch (error) {
      if (error instanceof TrainingOfficialUrlFetchError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
    if (normalizedUrl.hostname !== confirmedOfficialHost) {
      throw new BadRequestException(
        'Confirmed official host must exactly match the URL hostname',
      );
    }

    let sourceId: string;
    try {
      sourceId = await this.prisma.$transaction(async (tx) => {
        await this.assertDraftVersionLocked(tx, version.id);
        await tx.$queryRaw(
          Prisma.sql`SELECT 1 AS "locked" FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`training-official-url-source-cap:${version.id}`}, 0))) AS "lock_state"`,
        );
        const sourceCount = await tx.trainingOfficialUrlSource.count({
          where: { projectVersionId: version.id },
        });
        if (
          sourceCount >= TRAINING_MAX_OFFICIAL_URL_SOURCES_PER_VERSION
        ) {
          throw new ConflictException(
            `В рабочей редакции может быть не более ${TRAINING_MAX_OFFICIAL_URL_SOURCES_PER_VERSION} официальных ссылок`,
          );
        }
        const source = await tx.trainingOfficialUrlSource.create({
          data: {
            projectVersionId: version.id,
            confirmedById: actor.id,
            url: inputUrl.trim(),
            normalizedUrl: normalizedUrl.toString(),
            hostname: confirmedOfficialHost,
          },
          select: {
            id: true,
            fetchGeneration: true,
          },
        });
        await tx.trainingJob.create({
          data: {
            kind: TrainingJobKind.FETCH_OFFICIAL_URL_SOURCE,
            status: TrainingJobStatus.PENDING,
            payloadJson: {
              sourceId: source.id,
              fetchGeneration: source.fetchGeneration,
            },
            idempotencyKey: trainingOfficialUrlJobKey(
              source.id,
              source.fetchGeneration,
            ),
          },
        });
        await this.writeAudit(tx, {
          action: 'training.official-url-source.create',
          actor,
          request,
          entityId: source.id,
          metadata: {
            projectVersionId: version.id,
            hostname: confirmedOfficialHost,
            fetchGeneration: source.fetchGeneration,
          },
        });
        return source.id;
      });
    } catch (error) {
      if (isPrismaUniqueError(error)) {
        throw new ConflictException(
          'This official URL is already attached to the working version',
        );
      }
      throw error;
    }

    return this.getSource(version.id, sourceId!);
  }

  async getSourceText(versionIdInput: string, sourceIdInput: string) {
    const source = await this.findSource(versionIdInput, sourceIdInput);
    return {
      source: this.serializeSource(source),
      extractedText: source.extractedText ?? '',
      extractionMetadata: source.extractionMetadataJson,
      draftOnly: true as const,
      scoringEligible: false as const,
    };
  }

  async retrySource(
    versionIdInput: string,
    sourceIdInput: string,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const version = await this.requireDraftVersion(versionIdInput);
    const sourceId = this.parseUuid(
      sourceIdInput,
      'Official URL source is invalid',
    );
    let generation: number;

    await this.prisma.$transaction(async (tx) => {
      await this.assertDraftVersionLocked(tx, version.id);
      await tx.$queryRaw`SELECT "id" FROM "training_official_url_sources" WHERE "id" = ${sourceId}::uuid FOR UPDATE`;
      const source = await tx.trainingOfficialUrlSource.findFirst({
        where: {
          id: sourceId,
          projectVersionId: version.id,
        },
        select: {
          id: true,
          extractionStatus: true,
          fetchGeneration: true,
        },
      });
      if (!source) {
        throw new NotFoundException('Official URL source not found');
      }
      if (source.extractionStatus === TrainingSourceExtractionStatus.PROCESSING) {
        throw new ConflictException('Official URL source is already processing');
      }

      generation = source.fetchGeneration + 1;
      await tx.trainingOfficialUrlSource.update({
        where: { id: source.id },
        data: {
          fetchGeneration: generation,
          finalUrl: null,
          extractionStatus: TrainingSourceExtractionStatus.PENDING,
          extractedText: null,
          contentHash: null,
          extractionMetadataJson: {},
          errorCode: null,
          errorMessage: null,
          fetchedAt: null,
        },
      });
      await tx.trainingJob.create({
        data: {
          kind: TrainingJobKind.FETCH_OFFICIAL_URL_SOURCE,
          status: TrainingJobStatus.PENDING,
          payloadJson: {
            sourceId: source.id,
            fetchGeneration: generation,
            retryNonce: randomUUID(),
          },
          idempotencyKey: trainingOfficialUrlJobKey(source.id, generation),
        },
      });
      await this.writeAudit(tx, {
        action: 'training.official-url-source.retry',
        actor,
        request,
        entityId: source.id,
        metadata: {
          projectVersionId: version.id,
          fetchGeneration: generation,
        },
      });
    });

    return this.getSource(version.id, sourceId);
  }

  async deleteSource(
    versionIdInput: string,
    sourceIdInput: string,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const version = await this.requireDraftVersion(versionIdInput);
    const sourceId = this.parseUuid(
      sourceIdInput,
      'Official URL source is invalid',
    );
    let snapshotFileId: string | null = null;

    await this.prisma.$transaction(async (tx) => {
      await this.assertDraftVersionLocked(tx, version.id);
      await tx.$queryRaw`SELECT "id" FROM "training_official_url_sources" WHERE "id" = ${sourceId}::uuid FOR UPDATE`;
      const source = await tx.trainingOfficialUrlSource.findFirst({
        where: {
          id: sourceId,
          projectVersionId: version.id,
        },
        include: {
          _count: {
            select: {
              facts: true,
            },
          },
        },
      });
      if (!source) {
        throw new NotFoundException('Official URL source not found');
      }
      if (source.extractionStatus === TrainingSourceExtractionStatus.PROCESSING) {
        throw new ConflictException('Processing official URL source cannot be deleted');
      }
      if (source._count.facts > 0) {
        throw new ConflictException(
          'Remove this official URL from linked facts before deleting it',
        );
      }

      const activeFactSuggestionRunCount =
        await tx.trainingFactSuggestionRun.count({
          where: {
            projectVersionId: version.id,
            status: {
              in: [
                TrainingFactSuggestionRunStatus.PENDING,
                TrainingFactSuggestionRunStatus.RUNNING,
              ],
            },
            sourceSnapshotJson: {
              array_contains: [
                {
                  kind: 'OFFICIAL_URL',
                  id: source.id,
                },
              ],
            },
          },
        });
      if (activeFactSuggestionRunCount > 0) {
        throw new ConflictException(
          'Предложения фактов по этой ссылке ещё обрабатываются',
        );
      }

      const factSuggestionHistoryCount =
        await tx.trainingFactSuggestionProviderRun.count({
          where: { sourceOfficialUrlId: source.id },
        });
      if (factSuggestionHistoryCount > 0) {
        throw new ConflictException(
          'Ссылка использовалась для предложений фактов и не может быть удалена: история решений должна быть сохранена',
        );
      }

      const liveJobs = await tx.trainingJob.count({
        where: {
          kind: TrainingJobKind.FETCH_OFFICIAL_URL_SOURCE,
          status: {
            in: [TrainingJobStatus.PENDING, TrainingJobStatus.RUNNING],
          },
          payloadJson: {
            path: ['sourceId'],
            equals: source.id,
          },
        },
      });
      if (liveJobs > 0) {
        throw new ConflictException(
          'Official URL source has an active processing job',
        );
      }

      snapshotFileId = source.snapshotFileId;
      await tx.trainingOfficialUrlSource.delete({
        where: { id: source.id },
      });
      await this.writeAudit(tx, {
        action: 'training.official-url-source.delete',
        actor,
        request,
        entityId: source.id,
        metadata: {
          projectVersionId: version.id,
          hostname: source.hostname,
          snapshotFileId,
        },
      });
    });

    if (snapshotFileId) {
      await this.files.deleteUnlinkedFile(snapshotFileId);
    }
  }

  async getSnapshot(versionIdInput: string, sourceIdInput: string) {
    const source = await this.findSource(versionIdInput, sourceIdInput);
    if (!source.snapshotFile) {
      throw new NotFoundException('Official URL snapshot is not ready');
    }

    return {
      file: source.snapshotFile,
      buffer: await this.files.readStoredFile(source.snapshotFile),
    };
  }

  private async getSource(versionId: string, sourceId: string) {
    const source = await this.prisma.trainingOfficialUrlSource.findFirst({
      where: {
        id: sourceId,
        projectVersionId: versionId,
      },
      include: officialUrlSourceInclude,
    });
    if (!source) {
      throw new NotFoundException('Official URL source not found');
    }
    return { source: this.serializeSource(source) };
  }

  private async findSource(versionIdInput: string, sourceIdInput: string) {
    const versionId = this.parseUuid(
      versionIdInput,
      'Training version is invalid',
    );
    const sourceId = this.parseUuid(
      sourceIdInput,
      'Official URL source is invalid',
    );
    const source = await this.prisma.trainingOfficialUrlSource.findFirst({
      where: {
        id: sourceId,
        projectVersionId: versionId,
      },
      include: officialUrlSourceInclude,
    });
    if (!source) {
      throw new NotFoundException('Official URL source not found');
    }
    return source;
  }

  private serializeSource(source: OfficialUrlSourceRecord) {
    return {
      id: source.id,
      projectVersionId: source.projectVersionId,
      inputUrl: source.url,
      normalizedUrl: source.normalizedUrl,
      confirmedOfficialHost: source.hostname,
      extractionStatus: source.extractionStatus,
      errorMessage: source.errorMessage,
      extractedCharacterCount: source.extractedText?.length ?? 0,
      textPreview: source.extractedText?.slice(0, 500) ?? '',
      checksum: source.contentHash,
      fetchedAt: source.fetchedAt?.toISOString() ?? null,
      linkedFactCount: source._count.facts,
      snapshot: source.snapshotFile
        ? {
            id: source.snapshotFile.id,
            originalName: source.snapshotFile.originalName,
            mimeType: source.snapshotFile.mimeType,
            sizeBytes: source.snapshotFile.sizeBytes?.toString() ?? null,
          }
        : null,
      createdAt: source.createdAt.toISOString(),
      updatedAt: source.updatedAt.toISOString(),
    };
  }

  private async requireVersion(id: string) {
    const versionId = this.parseUuid(id, 'Training version is invalid');
    const version = await this.prisma.trainingProjectVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        status: true,
      },
    });
    if (!version) {
      throw new NotFoundException('Training version not found');
    }
    return version;
  }

  private async requireDraftVersion(id: string) {
    const version = await this.requireVersion(id);
    if (version.status !== TrainingVersionStatus.DRAFT) {
      throw new ConflictException(
        'Published training version is immutable; open its working version',
      );
    }
    return version;
  }

  private async assertDraftVersionLocked(
    tx: Prisma.TransactionClient,
    versionId: string,
  ) {
    const version = await lockTrainingVersionForContentMutation(tx, versionId);
    if (!version) {
      throw new NotFoundException('Training version not found');
    }
    if (
      version.status !== TrainingVersionStatus.DRAFT ||
      version.projectStatus === TrainingProjectStatus.ARCHIVED
    ) {
      throw new ConflictException(
        'Published training version is immutable; open its working version',
      );
    }
  }

  private assertOnlyFields(
    body: Record<string, unknown>,
    allowedFields: string[],
  ) {
    const unsupported = Object.keys(body).filter(
      (key) => !allowedFields.includes(key),
    );
    if (unsupported.length > 0) {
      throw new BadRequestException(
        `Unsupported fields: ${unsupported.join(', ')}`,
      );
    }
  }

  private parseUuid(value: string, message: string) {
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
    if (!uuidPattern.test(value)) {
      throw new BadRequestException(message);
    }
    return value;
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    input: {
      action: string;
      actor: AuthenticatedUser;
      request: TrainingAuditRequest;
      entityId: string;
      metadata: Prisma.InputJsonValue;
    },
  ) {
    await tx.auditLog.create({
      data: {
        action: input.action,
        actorUserId: input.actor.id,
        entityType: 'training_official_url_source',
        entityId: input.entityId,
        metadata: input.metadata,
        ipAddress:
          input.request.ip ?? input.request.socket?.remoteAddress ?? null,
        userAgent: Array.isArray(input.request.headers?.['user-agent'])
          ? input.request.headers['user-agent'].join(', ')
          : (input.request.headers?.['user-agent'] ?? null),
      },
    });
  }
}

export function trainingOfficialUrlJobKey(
  sourceId: string,
  fetchGeneration: number,
) {
  return `fetch-official-url-source:${sourceId}:${fetchGeneration}`;
}

function isPrismaUniqueError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
