import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { FeedFormat, FeedSourceKind, FeedUnitStatus, FeedUnitType, ImportMode, ImportStatus, Prisma } from '@prisma/client';

import { AuthenticatedUser } from '../auth/auth.types';
import { FilesService } from '../files/files.service';
import { UploadedFile } from '../files/uploaded-file.type';
import { PrismaService } from '../prisma/prisma.service';
import { createSearchContainsFilters } from '../search/search-filters';

const execFileAsync = promisify(execFile);
const feedRunQueueConcurrency = 3;
const feedAutoImportIntervalMs = 1000 * 60 * 60 * 2;
const feedPreviewCommandTimeoutMs = 1000 * 60 * 30;
const feedRunCommandTimeoutMs = 1000 * 60 * 180;
const supportedFeedSourceKinds = ['URL', 'FILE', 'INDEX_URL'] as const;
const supportedFeedSourceFormats = ['YANDEX_REALTY', 'CIAN_XML', 'AVITO_XML', 'FSK_XML', 'TEKTA_XML'] as const;

type FeedImportCommand = 'preview' | 'run';
type AnalyzeFeedFormat = FeedFormat | 'AUTO';
type BufferedUploadedFile = UploadedFile & { buffer: Buffer };
type SupportedFeedSourceKind = (typeof supportedFeedSourceKinds)[number];
type SupportedFeedSourceFormat = (typeof supportedFeedSourceFormats)[number];

type FeedImportRunQueueJob = {
  sourceId: string;
  runId: string;
};

type FeedAutoImportCycleResult = {
  sources: number;
  previewed: number;
  runsQueued: number;
  skipped: number;
  failed: number;
  isAlreadyRunning: boolean;
};

type ListFeedSourcesQuery = {
  page?: string;
  limit?: string;
  format?: string;
  developerId?: string;
  objectId?: string;
  isActive?: string;
};

type CreateFeedSourceBody = {
  sourceKind?: unknown;
  url?: unknown;
  format?: unknown;
  filterJson?: unknown;
  developerId?: unknown;
  objectId?: unknown;
  mappings?: unknown;
  isActive?: unknown;
};

type UpdateFeedSourceBody = Partial<CreateFeedSourceBody>;

type AnalyzeFeedSourceBody = {
  sourceKind?: unknown;
  url?: unknown;
  format?: unknown;
};

type ListFeedRunsQuery = {
  page?: string;
  limit?: string;
  mode?: string;
  status?: string;
};

type ListFeedUnitsQuery = {
  page?: string;
  limit?: string;
  sourceId?: string;
  objectId?: string;
  status?: string;
  type?: string;
  search?: string;
};

type ParsedFeedSourceMappingInput = {
  objectId: string;
  sourceKey: string;
  sourceTitle: string;
  filterJson: Record<string, unknown>;
  isActive: boolean;
};

const sourceInclude = {
  xmlFile: true,
  developer: true,
  object: {
    select: {
      id: true,
      title: true,
      slug: true,
      status: true,
    },
  },
  mappings: {
    include: {
      object: {
        select: {
          id: true,
          title: true,
          slug: true,
          status: true,
        },
      },
    },
    orderBy: {
      sourceTitle: 'asc' as const,
    },
  },
} as const;

const unitInclude = {
  residentialDetails: true,
  commercialDetails: true,
  media: {
    include: {
      mediaAsset: {
        include: {
          file: true,
        },
      },
    },
    orderBy: {
      sortOrder: 'asc' as const,
    },
  },
} as const;

type FeedSourceRecord = Prisma.FeedSourceGetPayload<{ include: typeof sourceInclude }>;
type FeedImportRunRecord = Prisma.FeedImportRunGetPayload<Record<string, never>>;
type FeedUnitRecord = Prisma.FeedUnitGetPayload<{ include: typeof unitInclude }>;
type FeedMediaFileRecord = NonNullable<FeedUnitRecord['media'][number]['mediaAsset']['file']>;

@Injectable()
export class FeedsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeedsService.name);
  private readonly activeSourceCommands = new Map<string, FeedImportCommand>();
  private readonly feedRunQueue: FeedImportRunQueueJob[] = [];
  private readonly activeFeedRunProcesses = new Map<string, ChildProcess>();
  private feedAutoImportTimer: ReturnType<typeof setInterval> | null = null;
  private isFeedAutoImportCycleRunning = false;
  private activeFeedRunCommands = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly filesService?: FilesService,
  ) {}

  onModuleInit() {
    if (!this.isFeedAutoImportSchedulerEnabled() || this.feedAutoImportTimer) {
      return;
    }

    this.feedAutoImportTimer = setInterval(() => {
      void this.runFeedAutoImportCycle();
    }, feedAutoImportIntervalMs);
    (this.feedAutoImportTimer as { unref?: () => void }).unref?.();
    void this.runFeedAutoImportCycle();
  }

  onModuleDestroy() {
    if (!this.feedAutoImportTimer) {
      return;
    }

    clearInterval(this.feedAutoImportTimer);
    this.feedAutoImportTimer = null;
  }

  async runFeedAutoImportCycle(): Promise<FeedAutoImportCycleResult> {
    if (this.isFeedAutoImportCycleRunning) {
      return {
        sources: 0,
        previewed: 0,
        runsQueued: 0,
        skipped: 0,
        failed: 0,
        isAlreadyRunning: true,
      };
    }

    this.isFeedAutoImportCycleRunning = true;
    const result: FeedAutoImportCycleResult = {
      sources: 0,
      previewed: 0,
      runsQueued: 0,
      skipped: 0,
      failed: 0,
      isAlreadyRunning: false,
    };

    try {
      const sources = await this.prisma.feedSource.findMany({
        where: {
          deletedAt: null,
          isActive: true,
        },
        select: {
          id: true,
        },
        orderBy: {
          createdAt: 'asc',
        },
      });

      result.sources = sources.length;

      for (const source of sources) {
        if (this.activeSourceCommands.has(source.id)) {
          result.skipped += 1;
          continue;
        }

        try {
          const previewResult = await this.runFeedImportCommand(source.id, 'preview');
          result.previewed += 1;

          if (previewResult.run.status !== ImportStatus.SUCCESS && previewResult.run.status !== ImportStatus.PARTIAL) {
            result.failed += 1;
            continue;
          }

          if (this.shouldRunFeedImportAfterPreview(previewResult.run)) {
            await this.runFeedImportCommand(source.id, 'run');
            result.runsQueued += 1;
          }
        } catch (error) {
          if (error instanceof ConflictException) {
            result.skipped += 1;
            continue;
          }

          result.failed += 1;
          this.logger.error(`Scheduled feed import failed for source ${source.id}: ${getCommandErrorMessage(error)}`);
        }
      }

      this.logger.log(
        `Scheduled feed import cycle finished: sources=${result.sources}, previewed=${result.previewed}, runsQueued=${result.runsQueued}, skipped=${result.skipped}, failed=${result.failed}`,
      );

      return result;
    } finally {
      this.isFeedAutoImportCycleRunning = false;
    }
  }

  async listSources(query: ListFeedSourcesQuery) {
    const page = this.parsePositiveInteger(query.page, 1);
    const limit = Math.min(this.parsePositiveInteger(query.limit, 20), 100);
    const where: Prisma.FeedSourceWhereInput = {
      deletedAt: null,
    };

    if (query.format) {
      where.format = this.parseFormat(query.format);
    }

    if (query.developerId) {
      where.developerId = this.parseUuid(query.developerId, 'Developer is invalid');
    }

    if (query.objectId) {
      const objectId = this.parseUuid(query.objectId, 'Object is invalid');
      where.OR = [
        {
          objectId,
        },
        {
          mappings: {
            some: {
              objectId,
            },
          },
        },
      ];
    }

    if (query.isActive !== undefined) {
      where.isActive = this.parseQueryBoolean(query.isActive, 'Feed source active flag is invalid');
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.feedSource.findMany({
        where,
        include: sourceInclude,
        orderBy: {
          createdAt: 'desc',
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.feedSource.count({ where }),
    ]);

    return {
      items: items.map((source) => this.serializeSource(source)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async createSource(
    body: CreateFeedSourceBody,
    xmlFile?: UploadedFile,
    actor?: AuthenticatedUser,
  ) {
    const sourceKind = this.parseSourceKind(body.sourceKind, xmlFile ? FeedSourceKind.FILE : FeedSourceKind.URL);
    const uploadedXmlFile = sourceKind === FeedSourceKind.FILE ? await this.uploadFeedXmlFile(xmlFile, actor) : null;
    const url = this.isUrlBackedSourceKind(sourceKind)
      ? this.parseHttpUrl(body.url, 'Feed source URL is required')
      : null;
    const format = this.parseFormat(body.format);
    const filterJson = this.parseFeedSourceFilterJson(body.filterJson);
    const developerId = this.parseUuid(this.parseRequiredString(body.developerId, 'Developer is required'), 'Developer is invalid');
    const mappings = this.parseFeedSourceMappings(body.mappings);
    const requestedObjectId = this.parseOptionalUuid(body.objectId, 'Object is invalid');
    const objectId = mappings.length > 0 ? null : requestedObjectId;
    const isActive = this.parseBoolean(body.isActive, true, 'Feed source active flag is invalid');

    await this.ensureDeveloperExists(developerId);
    await this.ensureSourceHasObjectOrMappings(objectId, mappings);

    const source = await this.prisma.feedSource.create({
      data: {
        sourceKind,
        url,
        ...(uploadedXmlFile
          ? {
              xmlFile: {
                connect: {
                  id: uploadedXmlFile.file.id,
                },
              },
            }
          : {}),
        format,
        filterJson: this.toNullableJsonInput(filterJson),
        isActive,
        developer: {
          connect: {
            id: developerId,
          },
        },
        ...(objectId
          ? {
              object: {
                connect: {
                  id: objectId,
                },
              },
            }
          : {}),
        ...(mappings.length > 0
          ? {
              mappings: {
                create: mappings.map((mapping) => this.createMappingWriteInput(mapping)),
              },
            }
          : {}),
      },
      include: sourceInclude,
    });

    return {
      source: this.serializeSource(source),
    };
  }

  async updateSource(
    id: string,
    body: UpdateFeedSourceBody,
    xmlFile?: UploadedFile,
    actor?: AuthenticatedUser,
  ) {
    const sourceId = this.parseUuid(id, 'Feed source is invalid');
    const source = await this.findExistingSource(sourceId);
    const data: Prisma.FeedSourceUncheckedUpdateInput = {};
    let hasChanges = false;
    const sourceKind = this.parseSourceKind(
      body.sourceKind,
      xmlFile ? FeedSourceKind.FILE : source.sourceKind,
    );

    if (this.isUrlBackedSourceKind(sourceKind)) {
      const url = 'url' in body
        ? this.parseHttpUrl(body.url, 'Feed source URL is required')
        : this.parseHttpUrl(source.url, 'Feed source URL is required');

      if (source.sourceKind !== sourceKind) {
        data.sourceKind = sourceKind;
        hasChanges = true;
      }

      if (url !== source.url) {
        data.url = url;
        hasChanges = true;
      }

      if (source.xmlFileId) {
        data.xmlFileId = null;
        hasChanges = true;
      }
    } else {
      const uploadedXmlFile = xmlFile ? await this.uploadFeedXmlFile(xmlFile, actor) : null;

      if (!uploadedXmlFile && source.sourceKind !== FeedSourceKind.FILE) {
        throw new BadRequestException('XML file is required');
      }

      if (!uploadedXmlFile && !source.xmlFileId) {
        throw new BadRequestException('XML file is required');
      }

      if (source.sourceKind !== FeedSourceKind.FILE) {
        data.sourceKind = FeedSourceKind.FILE;
        hasChanges = true;
      }

      if (source.url !== null) {
        data.url = null;
        hasChanges = true;
      }

      if (uploadedXmlFile) {
        data.xmlFileId = uploadedXmlFile.file.id;
        hasChanges = true;
      }
    }

    if ('format' in body) {
      const format = this.parseFormat(body.format);

      if (format !== source.format) {
        data.format = format;
        hasChanges = true;
      }
    }

    if ('filterJson' in body) {
      data.filterJson = this.toNullableJsonInput(this.parseFeedSourceFilterJson(body.filterJson));
      hasChanges = true;
    }

    const mappings = 'mappings' in body ? this.parseFeedSourceMappings(body.mappings) : null;

    if ('developerId' in body) {
      const developerId = this.parseUuid(
        this.parseRequiredString(body.developerId, 'Developer is required'),
        'Developer is invalid',
      );
      await this.ensureDeveloperExists(developerId);

      if (developerId !== source.developerId) {
        data.developerId = developerId;
        hasChanges = true;
      }
    }

    const nextMappings = mappings ?? source.mappings;
    const requestedObjectId = 'objectId' in body
      ? this.parseOptionalUuid(body.objectId, 'Object is invalid')
      : source.objectId;
    const nextObjectId = nextMappings.length > 0 ? null : requestedObjectId;

    if (nextObjectId !== source.objectId) {
      data.objectId = nextObjectId;
      hasChanges = true;
    }

    await this.ensureSourceHasObjectOrMappings(nextObjectId, nextMappings);

    if (mappings) {
      data.mappings = {
        deleteMany: {},
        create: mappings.map((mapping) => this.createUncheckedMappingWriteInput(mapping)),
      };
      hasChanges = true;
    }

    if ('isActive' in body) {
      const isActive = this.parseBoolean(body.isActive, source.isActive, 'Feed source active flag is invalid');

      if (isActive !== source.isActive) {
        data.isActive = isActive;
        hasChanges = true;
      }
    }

    if (!hasChanges) {
      return {
        source: this.serializeSource(source),
      };
    }

    const updatedSource = await this.prisma.feedSource.update({
      where: {
        id: source.id,
      },
      data,
      include: sourceInclude,
    });

    return {
      source: this.serializeSource(updatedSource),
    };
  }

  async deleteSource(id: string) {
    const sourceId = this.parseUuid(id, 'Feed source is invalid');
    const source = await this.findExistingSource(sourceId);
    const deletedAt = new Date();
    const deletedSource = await this.prisma.feedSource.update({
      where: {
        id: source.id,
      },
      data: {
        deletedAt,
        isActive: false,
      },
      include: sourceInclude,
    });

    return {
      source: this.serializeSource(deletedSource),
    };
  }

  async analyzeSource(body: AnalyzeFeedSourceBody, xmlFile?: UploadedFile) {
    const sourceKind = this.parseSourceKind(body.sourceKind, xmlFile ? FeedSourceKind.FILE : FeedSourceKind.URL);
    const format = this.parseAnalyzeFormat(body.format);
    const url = this.isUrlBackedSourceKind(sourceKind)
      ? this.parseHttpUrl(body.url, 'Feed source URL is required')
      : null;
    const analysisXmlFile = sourceKind === FeedSourceKind.FILE ? this.validateAnalysisXmlFile(xmlFile) : null;

    try {
      return await this.runFeedAnalyzeCli({
        format,
        sourceKind,
        url,
        xmlFile: analysisXmlFile,
      });
    } catch (error) {
      throw new InternalServerErrorException(getCommandErrorMessage(error));
    }
  }

  async runFeedImportCommand(sourceIdValue: string, mode: FeedImportCommand) {
    const sourceId = this.parseUuid(sourceIdValue, 'Feed source is invalid');

    if (this.activeSourceCommands.has(sourceId)) {
      throw new ConflictException('Feed source import is already running');
    }

    this.activeSourceCommands.set(sourceId, mode);
    let shouldReleaseActiveCommand = true;

    try {
      const source = await this.prisma.feedSource.findUnique({
        where: {
          id: sourceId,
        },
        select: {
          id: true,
          deletedAt: true,
        },
      });

      if (!source || source.deletedAt) {
        throw new NotFoundException('Feed source not found');
      }

      const startedAt = new Date();

      if (mode === 'run') {
        const result = await this.enqueueFeedImportRunCommand(sourceId, startedAt);
        shouldReleaseActiveCommand = false;

        return result;
      }

      try {
        await this.runFeedImportCli(mode, sourceId);

        const run = await this.findLatestRun(sourceId, mode, startedAt);

        return {
          run: this.serializeRun(run),
        };
      } catch (error) {
        const run = await this.findLatestRun(sourceId, mode, startedAt).catch(() => null);

        if (run) {
          return {
            run: this.serializeRun(run),
          };
        }

        throw new InternalServerErrorException(getCommandErrorMessage(error));
      }
    } finally {
      if (shouldReleaseActiveCommand) {
        this.activeSourceCommands.delete(sourceId);
      }
    }
  }

  private async enqueueFeedImportRunCommand(sourceId: string, startedAt: Date) {
    const [run] = await this.prisma.$transaction([
      this.prisma.feedImportRun.create({
        data: {
          sourceId,
          mode: ImportMode.RUN,
          status: ImportStatus.PENDING,
          startedAt,
          summaryJson: {
            progress: this.createQueuedFeedRunProgress(startedAt),
          },
        },
      }),
      this.prisma.feedSource.update({
        where: {
          id: sourceId,
        },
        data: {
          lastRunAt: startedAt,
        },
      }),
    ]);

    this.feedRunQueue.push({
      sourceId,
      runId: run.id,
    });
    this.drainFeedRunQueue();

    return {
      run: this.serializeRun(run),
    };
  }

  private drainFeedRunQueue() {
    while (this.activeFeedRunCommands < feedRunQueueConcurrency && this.feedRunQueue.length > 0) {
      const job = this.feedRunQueue.shift();

      if (!job) {
        return;
      }

      this.activeFeedRunCommands += 1;
      void this.executeQueuedFeedImportRun(job);
    }
  }

  private async executeQueuedFeedImportRun(job: FeedImportRunQueueJob) {
    try {
      await this.runFeedImportCli('run', job.sourceId, job.runId);
    } catch (error) {
      this.logger.error(`Feed import run failed for source ${job.sourceId}: ${getCommandErrorMessage(error)}`);
      await this.markPendingQueuedFeedImportRunFailed(job.runId, error);
    } finally {
      this.activeFeedRunCommands = Math.max(0, this.activeFeedRunCommands - 1);
      this.activeSourceCommands.delete(job.sourceId);
      this.drainFeedRunQueue();
    }
  }

  private createQueuedFeedRunProgress(date: Date) {
    return {
      stage: 'QUEUED',
      unitsTotal: 0,
      unitsProcessed: 0,
      unitsRemaining: 0,
      mediaTotal: 0,
      mediaProcessed: 0,
      mediaRemaining: 0,
      updatedAt: date.toISOString(),
    };
  }

  private isFeedAutoImportSchedulerEnabled() {
    const flag = process.env.FEED_AUTO_IMPORT_ENABLED?.trim().toLowerCase();

    if (flag) {
      return !['0', 'false', 'no', 'off'].includes(flag);
    }

    return process.env.NODE_ENV === 'production';
  }

  private shouldRunFeedImportAfterPreview(run: { status: ImportStatus; summaryJson: unknown }) {
    if (run.status !== ImportStatus.SUCCESS && run.status !== ImportStatus.PARTIAL) {
      return false;
    }

    if (!this.isPlainJsonObject(run.summaryJson)) {
      return false;
    }

    const media = this.isPlainJsonObject(run.summaryJson.media) ? run.summaryJson.media : {};

    return (
      this.getPositiveJsonNumber(run.summaryJson.created) > 0 ||
      this.getPositiveJsonNumber(run.summaryJson.updated) > 0 ||
      this.getPositiveJsonNumber(run.summaryJson.archived) > 0 ||
      this.getPositiveJsonNumber(media.created) > 0 ||
      this.getPositiveJsonNumber(media.downloaded) > 0 ||
      this.getPositiveJsonNumber(media.failed) > 0 ||
      this.getPositiveJsonNumber(media.variantsCreated) > 0
    );
  }

  private getPositiveJsonNumber(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  }

  private async markPendingQueuedFeedImportRunFailed(runId: string, error: unknown) {
    const currentRun = await this.prisma.feedImportRun.findUnique({
      where: {
        id: runId,
      },
      select: {
        status: true,
      },
    });

    if (!currentRun || currentRun.status !== ImportStatus.PENDING) {
      return;
    }

    const finishedAt = new Date();

    await this.prisma.feedImportRun.update({
      where: {
        id: runId,
      },
      data: {
        status: ImportStatus.FAILED,
        finishedAt,
        errorsJson: [
          {
            code: 'FEED_IMPORT_QUEUE_FAILED',
            message: getCommandErrorMessage(error),
          },
        ],
        summaryJson: {
          progress: {
            stage: 'FAILED',
            unitsTotal: 0,
            unitsProcessed: 0,
            unitsRemaining: 0,
            mediaTotal: 0,
            mediaProcessed: 0,
            mediaRemaining: 0,
            updatedAt: finishedAt.toISOString(),
          },
        },
      },
    });
  }

  private async markFeedImportRunStopped(run: FeedImportRunRecord) {
    const finishedAt = new Date();

    return this.prisma.feedImportRun.update({
      where: {
        id: run.id,
      },
      data: {
        status: ImportStatus.FAILED,
        finishedAt,
        errorsJson: [
          {
            code: 'FEED_IMPORT_STOPPED',
            message: 'Загрузка фида остановлена пользователем',
          },
        ],
        summaryJson: this.createStoppedFeedRunSummary(run.summaryJson, finishedAt),
      },
    });
  }

  private createStoppedFeedRunSummary(summaryJson: unknown, finishedAt: Date) {
    const summary = this.isPlainJsonObject(summaryJson) ? { ...summaryJson } : {};
    const progress = this.isPlainJsonObject(summary.progress) ? { ...summary.progress } : {};

    return {
      ...summary,
      progress: {
        ...progress,
        stage: 'STOPPED',
        updatedAt: finishedAt.toISOString(),
      },
    };
  }

  private async stopFeedRunProcesses(runId: string) {
    let didSignalProcess = false;
    const activeProcess = this.activeFeedRunProcesses.get(runId);

    if (activeProcess) {
      didSignalProcess = this.signalFeedRunProcess(activeProcess.pid) || didSignalProcess;
    }

    const processIds = await this.findFeedRunProcessIds(runId);

    for (const processId of processIds) {
      didSignalProcess = this.signalFeedRunProcess(processId) || didSignalProcess;
    }

    return didSignalProcess;
  }

  private signalFeedRunProcess(processId: number | undefined) {
    if (!processId || processId === process.pid) {
      return false;
    }

    try {
      process.kill(-processId, 'SIGTERM');
      return true;
    } catch {
      try {
        process.kill(processId, 'SIGTERM');
        return true;
      } catch {
        return false;
      }
    }
  }

  private async findFeedRunProcessIds(runId: string) {
    const processIds = new Set<number>();

    await this.findFeedRunProcessIdsWithProcfs(runId, processIds);
    await this.findFeedRunProcessIdsWithPgrep(runId, processIds);

    return [...processIds].filter((processId) => processId !== process.pid);
  }

  private async findFeedRunProcessIdsWithProcfs(runId: string, processIds: Set<number>) {
    if (!existsSync('/proc')) {
      return;
    }

    const entries = await readdir('/proc', { withFileTypes: true }).catch(() => []);

    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
          return;
        }

        const commandLine = await readFile(`/proc/${entry.name}/cmdline`, 'utf8').catch(() => '');

        if (commandLine.includes('--run-id') && commandLine.includes(runId)) {
          processIds.add(Number(entry.name));
        }
      }),
    );
  }

  private async findFeedRunProcessIdsWithPgrep(runId: string, processIds: Set<number>) {
    const result = await execFileAsync('pgrep', ['-f', runId]).catch(() => null);

    if (!result) {
      return;
    }

    for (const line of result.stdout.split(/\r?\n/)) {
      const processId = Number(line.trim());

      if (Number.isInteger(processId) && processId > 0) {
        processIds.add(processId);
      }
    }
  }

  async runFeedImportCli(mode: FeedImportCommand, sourceId: string, runId?: string | null) {
    const args = ['--filter', '@platforma/feed-import', '--fail-if-no-match', 'run', mode, '--source', sourceId];

    if (runId) {
      args.push('--run-id', runId);
    }

    await new Promise<void>((resolvePromise, rejectPromise) => {
      let commandOutput = '';
      let didSettle = false;
      const timeoutMs = mode === 'run' ? feedRunCommandTimeoutMs : feedPreviewCommandTimeoutMs;
      const isDetachedRun = mode === 'run' && Boolean(runId);
      const childProcess = spawn('pnpm', args, {
        cwd: findWorkspaceRoot(),
        detached: isDetachedRun,
        env: {
          ...process.env,
          PRISMA_HIDE_UPDATE_MESSAGE: 'true',
        },
        stdio: isDetachedRun ? 'ignore' : ['ignore', 'pipe', 'pipe'],
      });
      const appendCommandOutput = (chunk: Buffer) => {
        if (commandOutput.length < 4000) {
          commandOutput += chunk.toString('utf8');
        }
      };
      const timeoutId = setTimeout(() => {
        if (!didSettle) {
          this.signalFeedRunProcess(childProcess.pid);
        }
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timeoutId);

        if (runId) {
          this.activeFeedRunProcesses.delete(runId);
        }
      };

      childProcess.stdout?.on('data', appendCommandOutput);
      childProcess.stderr?.on('data', appendCommandOutput);
      childProcess.once('error', (error) => {
        didSettle = true;
        cleanup();
        rejectPromise(error);
      });
      childProcess.once('close', (code, signal) => {
        didSettle = true;
        cleanup();

        if (code === 0) {
          resolvePromise();
          return;
        }

        rejectPromise(new Error(commandOutput.trim() || `Feed import command failed with code ${code ?? signal}`));
      });

      if (runId) {
        this.activeFeedRunProcesses.set(runId, childProcess);
      }
    });
  }

  async runFeedAnalyzeCli(params: {
    format: AnalyzeFeedFormat;
    sourceKind: FeedSourceKind;
    url: string | null;
    xmlFile: BufferedUploadedFile | null;
  }) {
    const tempDir = await mkdtemp(join(tmpdir(), 'platforma-feed-analyze-'));
    const outputPath = join(tempDir, 'analysis.json');
    const args = [
      '--filter',
      '@platforma/feed-import',
      '--fail-if-no-match',
      'run',
      'analyze',
      '--',
      '--format',
      params.format,
      '--source-kind',
      params.sourceKind,
      '--output',
      outputPath,
    ];

    try {
      if (params.xmlFile) {
        const inputPath = join(tempDir, 'feed.xml');
        await writeFile(inputPath, params.xmlFile.buffer);
        args.push('--file', inputPath);
      } else if (params.url) {
        args.push('--url', params.url);
      } else {
        throw new BadRequestException('Feed source URL or XML file is required');
      }

      await execFileAsync('pnpm', args, {
        cwd: findWorkspaceRoot(),
        env: {
          ...process.env,
          PRISMA_HIDE_UPDATE_MESSAGE: 'true',
        },
        maxBuffer: 1024 * 1024 * 50,
        timeout: 1000 * 60 * 5,
      });

      return this.parseFeedAnalysisCliOutput(await readFile(outputPath, 'utf8'));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async listSourceRuns(sourceIdValue: string, query: ListFeedRunsQuery) {
    const sourceId = this.parseUuid(sourceIdValue, 'Feed source is invalid');
    await this.ensureFeedSourceExists(sourceId);

    const page = this.parsePositiveInteger(query.page, 1);
    const limit = Math.min(this.parsePositiveInteger(query.limit, 20), 100);
    const where: Prisma.FeedImportRunWhereInput = {
      sourceId,
    };

    if (query.mode) {
      where.mode = this.parseImportMode(query.mode);
    }

    if (query.status) {
      where.status = this.parseImportStatus(query.status);
    }

    const [items, total] = await this.prisma.$transaction([
      this.prisma.feedImportRun.findMany({
        where,
        orderBy: {
          createdAt: 'desc',
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.feedImportRun.count({ where }),
    ]);

    return {
      items: items.map((run) => this.serializeRun(run)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async getRun(id: string) {
    const runId = this.parseUuid(id, 'Feed import run is invalid');
    const run = await this.prisma.feedImportRun.findUnique({
      where: {
        id: runId,
      },
    });

    if (!run) {
      throw new NotFoundException('Feed import run not found');
    }

    return {
      run: this.serializeRun(run),
    };
  }

  async stopFeedImportRun(id: string) {
    const runId = this.parseUuid(id, 'Feed import run is invalid');
    const run = await this.prisma.feedImportRun.findUnique({
      where: {
        id: runId,
      },
    });

    if (!run) {
      throw new NotFoundException('Feed import run not found');
    }

    if (run.mode !== ImportMode.RUN || run.status !== ImportStatus.PENDING) {
      throw new ConflictException('Feed import run is not active');
    }

    const queuedIndex = this.feedRunQueue.findIndex((job) => job.runId === run.id);

    if (queuedIndex >= 0) {
      this.feedRunQueue.splice(queuedIndex, 1);
      this.activeSourceCommands.delete(run.sourceId);
    } else {
      const didSignalProcess = await this.stopFeedRunProcesses(run.id);

      if (!didSignalProcess) {
        throw new ConflictException('Feed import run process was not found');
      }
    }

    const stoppedRun = await this.markFeedImportRunStopped(run);

    return {
      run: this.serializeRun(stoppedRun),
    };
  }

  async listUnits(query: ListFeedUnitsQuery) {
    const page = this.parsePositiveInteger(query.page, 1);
    const limit = Math.min(this.parsePositiveInteger(query.limit, 20), 100);
    const filters: Prisma.FeedUnitWhereInput[] = [];
    const discountScopeFilters: Prisma.FeedUnitWhereInput[] = [];

    if (query.sourceId) {
      const sourceId = this.parseUuid(query.sourceId, 'Feed source is invalid');
      filters.push({
        sourceId,
      });
      discountScopeFilters.push({
        sourceId,
      });
    }

    if (query.objectId) {
      const objectId = this.parseUuid(query.objectId, 'Object is invalid');
      filters.push({
        objectId,
      });
      discountScopeFilters.push({
        objectId,
      });
    }

    if (query.status) {
      filters.push({
        status: this.parseFeedUnitStatus(query.status),
      });
    }

    if (query.type) {
      filters.push({
        type: this.parseFeedUnitType(query.type),
      });
    }

    const search = query.search?.trim();

    if (search) {
      filters.push({
        OR: createSearchContainsFilters(search, ['externalId', 'title', 'address']),
      });
    }

    const where: Prisma.FeedUnitWhereInput = filters.length > 0 ? { AND: filters } : {};
    const discountWhere: Prisma.FeedUnitWhereInput =
      discountScopeFilters.length > 0
        ? {
            AND: [
              ...discountScopeFilters,
              {
                discountPrice: {
                  not: null,
                },
              },
            ],
          }
        : {
            discountPrice: {
              not: null,
            },
          };

    const [items, discountedUnitsCount, total] = await this.prisma.$transaction([
      this.prisma.feedUnit.findMany({
        where,
        include: unitInclude,
        orderBy: {
          createdAt: 'desc',
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.feedUnit.count({ where: discountWhere }),
      this.prisma.feedUnit.count({ where }),
    ]);

    return {
      items: items.map((unit) => this.serializeUnit(unit)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasDiscountPrices: discountedUnitsCount > 0,
    };
  }

  private async findExistingSource(id: string) {
    const source = await this.prisma.feedSource.findUnique({
      where: {
        id,
      },
      include: sourceInclude,
    });

    if (!source || source.deletedAt) {
      throw new NotFoundException('Feed source not found');
    }

    return source;
  }

  private async findLatestRun(sourceId: string, mode: FeedImportCommand, startedAt: Date) {
    const run = await this.findLatestRunOrNull(sourceId, mode, startedAt);

    if (!run) {
      throw new NotFoundException('Feed import run not found');
    }

    return run;
  }

  private async findLatestRunOrNull(sourceId: string, mode: FeedImportCommand, startedAt: Date) {
    return this.prisma.feedImportRun.findFirst({
      where: {
        sourceId,
        mode: mode === 'preview' ? ImportMode.PREVIEW : ImportMode.RUN,
        createdAt: {
          gte: startedAt,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  private async ensureDeveloperExists(developerId: string) {
    const count = await this.prisma.developer.count({
      where: {
        id: developerId,
      },
    });

    if (count === 0) {
      throw new BadRequestException('Developer is invalid');
    }
  }

  private async ensureObjectExists(objectId: string) {
    const count = await this.prisma.realEstateObject.count({
      where: {
        id: objectId,
        deletedAt: null,
      },
    });

    if (count === 0) {
      throw new BadRequestException('Object is invalid');
    }
  }

  private async ensureFeedSourceExists(sourceId: string) {
    const count = await this.prisma.feedSource.count({
      where: {
        id: sourceId,
        deletedAt: null,
      },
    });

    if (count === 0) {
      throw new NotFoundException('Feed source not found');
    }
  }

  private serializeSource(source: FeedSourceRecord) {
    return {
      id: source.id,
      sourceKind: source.sourceKind,
      url: source.url,
      xmlFileId: source.xmlFileId,
      xmlFile: source.xmlFile ? this.serializeFile(source.xmlFile) : null,
      format: source.format,
      filterJson: source.filterJson ?? null,
      developerId: source.developerId,
      objectId: source.objectId,
      isActive: source.isActive,
      deletedAt: source.deletedAt?.toISOString() ?? null,
      lastPreviewAt: source.lastPreviewAt?.toISOString() ?? null,
      lastRunAt: source.lastRunAt?.toISOString() ?? null,
      lastSuccessAt: source.lastSuccessAt?.toISOString() ?? null,
      developer: {
        id: source.developer.id,
        wpTermId: source.developer.wpTermId,
        name: source.developer.name,
        slug: source.developer.slug,
      },
      object: source.object
        ? {
            id: source.object.id,
            title: source.object.title,
            slug: source.object.slug,
            status: source.object.status,
          }
        : null,
      mappings: source.mappings.map((mapping) => ({
        id: mapping.id,
        sourceId: mapping.sourceId,
        objectId: mapping.objectId,
        sourceKey: mapping.sourceKey,
        sourceTitle: mapping.sourceTitle,
        filterJson: mapping.filterJson,
        isActive: mapping.isActive,
        object: {
          id: mapping.object.id,
          title: mapping.object.title,
          slug: mapping.object.slug,
          status: mapping.object.status,
        },
        createdAt: mapping.createdAt.toISOString(),
        updatedAt: mapping.updatedAt.toISOString(),
      })),
      createdAt: source.createdAt.toISOString(),
      updatedAt: source.updatedAt.toISOString(),
    };
  }

  private serializeRun(run: FeedImportRunRecord) {
    return {
      id: run.id,
      sourceId: run.sourceId,
      mode: run.mode,
      status: run.status,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      summaryJson: run.summaryJson ?? null,
      warningsJson: run.warningsJson ?? null,
      errorsJson: run.errorsJson ?? null,
      createdAt: run.createdAt.toISOString(),
    };
  }

  private serializeUnit(unit: FeedUnitRecord) {
    return {
      id: unit.id,
      sourceId: unit.sourceId,
      objectId: unit.objectId,
      externalId: unit.externalId,
      type: unit.type,
      status: unit.status,
      title: unit.title,
      address: unit.address,
      building: unit.building,
      section: unit.section,
      floor: unit.floor,
      rooms: unit.rooms,
      price: this.decimalToString(unit.price),
      discountPrice: this.decimalToString(unit.discountPrice),
      effectivePrice: this.decimalToString(unit.effectivePrice),
      currency: unit.currency,
      area: this.decimalToString(unit.area),
      pricePerMeter: this.decimalToString(unit.pricePerMeter),
      discountPricePerMeter: this.decimalToString(unit.discountPricePerMeter),
      effectivePricePerMeter: this.decimalToString(unit.effectivePricePerMeter),
      completionYear: unit.completionYear,
      completionQuarter: unit.completionQuarter,
      rawPayload: unit.rawPayload ?? null,
      archivedAt: unit.archivedAt?.toISOString() ?? null,
      residentialDetails: unit.residentialDetails
        ? {
            unitId: unit.residentialDetails.unitId,
            apartmentNumber: unit.residentialDetails.apartmentNumber,
            layoutType: unit.residentialDetails.layoutType,
            livingArea: this.decimalToString(unit.residentialDetails.livingArea),
            kitchenArea: this.decimalToString(unit.residentialDetails.kitchenArea),
            balconyCount: unit.residentialDetails.balconyCount,
            detailsJson: unit.residentialDetails.detailsJson,
          }
        : null,
      commercialDetails: unit.commercialDetails
        ? {
            unitId: unit.commercialDetails.unitId,
            commercialType: unit.commercialDetails.commercialType,
            entrance: unit.commercialDetails.entrance,
            ceilingHeight: this.decimalToString(unit.commercialDetails.ceilingHeight),
            powerKw: this.decimalToString(unit.commercialDetails.powerKw),
            separateEntrance: unit.commercialDetails.separateEntrance,
            detailsJson: unit.commercialDetails.detailsJson,
          }
        : null,
      media: unit.media.map((link) => ({
        id: link.mediaAsset.id,
        sourceUrl: link.mediaAsset.sourceUrl,
        file: link.mediaAsset.file ? this.serializeFile(link.mediaAsset.file) : null,
        contentType: link.mediaAsset.contentType,
        checksum: link.mediaAsset.checksum,
        sortOrder: link.sortOrder,
        label: link.label,
        createdAt: link.mediaAsset.createdAt.toISOString(),
        updatedAt: link.mediaAsset.updatedAt.toISOString(),
      })),
      createdAt: unit.createdAt.toISOString(),
      updatedAt: unit.updatedAt.toISOString(),
    };
  }

  private serializeFile(file: FeedMediaFileRecord) {
    return {
      id: file.id,
      wpAttachmentId: file.wpAttachmentId,
      storage: file.storage,
      bucket: file.bucket,
      key: file.key,
      url: file.url,
      originalName: file.originalName,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes?.toString() ?? null,
      checksum: file.checksum,
      createdAt: file.createdAt.toISOString(),
      updatedAt: file.updatedAt.toISOString(),
    };
  }

  private parseFormat(value: unknown) {
    if (typeof value !== 'string') {
      throw new BadRequestException('Feed format is invalid');
    }

    const format = value.trim().toUpperCase();

    if (!supportedFeedSourceFormats.includes(format as SupportedFeedSourceFormat)) {
      throw new BadRequestException('Feed format is invalid');
    }

    return format as FeedFormat;
  }

  private parseAnalyzeFormat(value: unknown): AnalyzeFeedFormat {
    if (typeof value !== 'string') {
      throw new BadRequestException('Feed format is invalid');
    }

    const format = value.trim().toUpperCase();

    if (format === 'AUTO') {
      return format;
    }

    if (!supportedFeedSourceFormats.includes(format as SupportedFeedSourceFormat)) {
      throw new BadRequestException('Feed format is invalid');
    }

    return format as FeedFormat;
  }

  private parseFeedSourceFilterJson(value: unknown) {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    const parsedValue = typeof value === 'string' ? this.parseJsonString(value) : value;

    if (!this.isPlainJsonObject(parsedValue)) {
      throw new BadRequestException('Feed source filter must be a JSON object');
    }

    return parsedValue as Prisma.InputJsonObject;
  }

  private parseFeedSourceMappings(value: unknown): ParsedFeedSourceMappingInput[] {
    if (value === undefined || value === null || value === '') {
      return [];
    }

    const parsedValue = typeof value === 'string' ? this.parseJsonString(value) : value;

    if (!Array.isArray(parsedValue)) {
      throw new BadRequestException('Feed source mappings must be a JSON array');
    }

    const seenSourceKeys = new Set<string>();

    return parsedValue.map((mapping, index) => {
      if (!this.isPlainJsonObject(mapping)) {
        throw new BadRequestException(`Feed source mapping #${index + 1} is invalid`);
      }

      const objectId = this.parseUuid(
        this.parseRequiredString(mapping.objectId, `Feed source mapping #${index + 1} object is required`),
        `Feed source mapping #${index + 1} object is invalid`,
      );
      const sourceKey = this.parseLimitedRequiredString(
        mapping.sourceKey,
        `Feed source mapping #${index + 1} key is required`,
        255,
      );
      const sourceTitle = this.parseLimitedRequiredString(
        mapping.sourceTitle,
        `Feed source mapping #${index + 1} title is required`,
        300,
      );
      const filterJson = mapping.filterJson;

      if (!this.isPlainJsonObject(filterJson)) {
        throw new BadRequestException(`Feed source mapping #${index + 1} filter must be a JSON object`);
      }

      if (seenSourceKeys.has(sourceKey)) {
        throw new BadRequestException(`Feed source mapping key "${sourceKey}" is duplicated`);
      }

      seenSourceKeys.add(sourceKey);

      return {
        objectId,
        sourceKey,
        sourceTitle,
        filterJson,
        isActive: this.parseBoolean(mapping.isActive, true, `Feed source mapping #${index + 1} active flag is invalid`),
      };
    });
  }

  private createMappingWriteInput(mapping: ParsedFeedSourceMappingInput) {
    return {
      sourceKey: mapping.sourceKey,
      sourceTitle: mapping.sourceTitle,
      filterJson: mapping.filterJson as Prisma.InputJsonObject,
      isActive: mapping.isActive,
      object: {
        connect: {
          id: mapping.objectId,
        },
      },
    };
  }

  private createUncheckedMappingWriteInput(mapping: ParsedFeedSourceMappingInput) {
    return {
      sourceKey: mapping.sourceKey,
      sourceTitle: mapping.sourceTitle,
      filterJson: mapping.filterJson as Prisma.InputJsonObject,
      isActive: mapping.isActive,
      objectId: mapping.objectId,
    };
  }

  private async ensureSourceHasObjectOrMappings(
    objectId: string | null,
    mappings: Array<{ objectId: string }>,
  ) {
    const mappingObjectIds = Array.from(new Set(mappings.map((mapping) => mapping.objectId)));

    if (!objectId && mappingObjectIds.length === 0) {
      throw new BadRequestException('Choose a linked object or at least one feed mapping');
    }

    if (objectId) {
      await this.ensureObjectExists(objectId);
    }

    await Promise.all(mappingObjectIds.map((mappingObjectId) => this.ensureObjectExists(mappingObjectId)));
  }

  private validateAnalysisXmlFile(file: UploadedFile | undefined): BufferedUploadedFile {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('XML file is required');
    }

    if (!file.buffer.toString('utf8', 0, Math.min(file.buffer.length, 256)).trimStart().startsWith('<')) {
      throw new BadRequestException('Only XML files are allowed');
    }

    return {
      ...file,
      buffer: file.buffer,
    };
  }

  private parseFeedAnalysisCliOutput(value: string) {
    const parsedValue = this.parseJsonString(value);

    if (!this.isPlainJsonObject(parsedValue)) {
      throw new InternalServerErrorException('Feed analysis command returned invalid response');
    }

    const discovery = parsedValue.discovery ?? null;
    const analysis = parsedValue.analysis ?? null;

    if (discovery !== null && !this.isPlainJsonObject(discovery)) {
      throw new InternalServerErrorException('Feed analysis command returned invalid response');
    }

    if (analysis !== null && !this.isPlainJsonObject(analysis)) {
      throw new InternalServerErrorException('Feed analysis command returned invalid response');
    }

    return {
      discovery,
      analysis,
    };
  }

  private parseJsonString(value: string) {
    const trimmedValue = value.trim();

    if (!trimmedValue) {
      return null;
    }

    try {
      return JSON.parse(trimmedValue) as unknown;
    } catch {
      throw new BadRequestException('Feed source filter must be valid JSON');
    }
  }

  private isPlainJsonObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  private toNullableJsonInput(value: Prisma.InputJsonObject | null) {
    return value ?? Prisma.DbNull;
  }

  private parseSourceKind(value: unknown, fallback: FeedSourceKind) {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException('Feed source kind is invalid');
    }

    const sourceKind = value.trim().toUpperCase();

    if (!supportedFeedSourceKinds.includes(sourceKind as SupportedFeedSourceKind)) {
      throw new BadRequestException('Feed source kind is invalid');
    }

    return sourceKind as FeedSourceKind;
  }

  private isUrlBackedSourceKind(sourceKind: FeedSourceKind) {
    return sourceKind === 'URL' || sourceKind === 'INDEX_URL';
  }

  private parseImportMode(value: string) {
    const mode = value.trim().toUpperCase();

    if (!Object.values(ImportMode).includes(mode as ImportMode)) {
      throw new BadRequestException('Feed import mode is invalid');
    }

    return mode as ImportMode;
  }

  private parseImportStatus(value: string) {
    const status = value.trim().toUpperCase();

    if (!Object.values(ImportStatus).includes(status as ImportStatus)) {
      throw new BadRequestException('Feed import status is invalid');
    }

    return status as ImportStatus;
  }

  private parseFeedUnitStatus(value: string) {
    const status = value.trim().toUpperCase();

    if (!Object.values(FeedUnitStatus).includes(status as FeedUnitStatus)) {
      throw new BadRequestException('Feed unit status is invalid');
    }

    return status as FeedUnitStatus;
  }

  private parseFeedUnitType(value: string) {
    const type = value.trim().toUpperCase();

    if (!Object.values(FeedUnitType).includes(type as FeedUnitType)) {
      throw new BadRequestException('Feed unit type is invalid');
    }

    return type as FeedUnitType;
  }

  private parseHttpUrl(value: unknown, message: string) {
    if (typeof value !== 'string') {
      throw new BadRequestException(message);
    }

    const normalized = value.trim();

    if (!normalized || normalized.length > 2048) {
      throw new BadRequestException(message);
    }

    try {
      const url = new URL(normalized);

      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new BadRequestException('Feed source URL is invalid');
      }

      return url.toString();
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new BadRequestException('Feed source URL is invalid');
    }
  }

  private parseRequiredString(value: unknown, message: string) {
    if (typeof value !== 'string') {
      throw new BadRequestException(message);
    }

    const normalized = value.trim();

    if (!normalized) {
      throw new BadRequestException(message);
    }

    return normalized;
  }

  private parseLimitedRequiredString(value: unknown, message: string, maxLength: number) {
    const normalized = this.parseRequiredString(value, message);

    if (normalized.length > maxLength) {
      throw new BadRequestException(message);
    }

    return normalized;
  }

  private parseBoolean(value: unknown, fallback: boolean, message: string) {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();

      if (normalized === 'true') {
        return true;
      }

      if (normalized === 'false') {
        return false;
      }
    }

    if (typeof value !== 'boolean') {
      throw new BadRequestException(message);
    }

    return value;
  }

  private parseQueryBoolean(value: string, message: string) {
    const normalized = value.trim().toLowerCase();

    if (normalized === 'true') {
      return true;
    }

    if (normalized === 'false') {
      return false;
    }

    throw new BadRequestException(message);
  }

  private parsePositiveInteger(value: string | undefined, fallback: number) {
    if (!value) {
      return fallback;
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed < 1) {
      return fallback;
    }

    return parsed;
  }

  private parseUuid(value: string, message: string) {
    const normalized = value.trim();

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
      throw new BadRequestException(message);
    }

    return normalized;
  }

  private parseOptionalUuid(value: unknown, message: string) {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(message);
    }

    return this.parseUuid(value, message);
  }

  private decimalToString(value: Prisma.Decimal | null) {
    return value?.toString() ?? null;
  }

  private async uploadFeedXmlFile(file: UploadedFile | undefined, actor: AuthenticatedUser | undefined) {
    if (!file) {
      throw new BadRequestException('XML file is required');
    }

    if (!actor || !this.filesService) {
      throw new InternalServerErrorException('Feed XML upload is unavailable');
    }

    return this.filesService.uploadFile(file, actor, 'feed-xml');
  }
}

function findWorkspaceRoot() {
  let currentDir = process.cwd();

  while (currentDir !== dirname(currentDir)) {
    if (existsSync(resolve(currentDir, 'pnpm-workspace.yaml'))) {
      return currentDir;
    }

    currentDir = dirname(currentDir);
  }

  return process.cwd();
}

function getCommandErrorMessage(error: unknown) {
  if (error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string') {
    const stderr = normalizeCommandOutput(error.stderr);

    if (stderr) {
      return stderr;
    }
  }

  if (error && typeof error === 'object' && 'stdout' in error && typeof error.stdout === 'string') {
    const stdout = normalizeCommandOutput(error.stdout);

    if (stdout) {
      return stdout;
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return 'Feed import command failed';
}

function normalizeCommandOutput(value: string) {
  return value
    .replace(/\u001b\[[0-9;]*m/gu, '')
    .replace(/┌[\s\S]*?┘\s*/gu, '')
    .trim();
}
