import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AssistantKnowledgeSourceState,
  AssistantKnowledgeSourceType,
  AssistantSourceJobStatus,
  AssistantSourceJobTrigger,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { AssistantSourceConnectorRegistry } from './assistant-source-connector.registry';

const maximumPilotProjects = 20;
const maximumPilotDevelopers = 7;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const officialTypes = new Set<AssistantKnowledgeSourceType>([
  AssistantKnowledgeSourceType.DEVELOPMENT_PAGE,
  AssistantKnowledgeSourceType.DEVELOPER_PROMOTION,
  AssistantKnowledgeSourceType.BANK_PROMOTION,
]);
const aggregatorConnectors = new Map<AssistantKnowledgeSourceType, string>([
  [AssistantKnowledgeSourceType.AGGREGATOR_CIAN, 'CIAN'],
  [AssistantKnowledgeSourceType.AGGREGATOR_DOMCLICK, 'DOMCLICK'],
  [AssistantKnowledgeSourceType.AGGREGATOR_YANDEX, 'YANDEX_REALTY'],
  [AssistantKnowledgeSourceType.AGGREGATOR_NOVOSTROY, 'NOVOSTROY_M'],
]);

const sourceHealthInclude = {
  revisions: {
    orderBy: [{ fetchedAt: 'desc' as const }, { id: 'desc' as const }],
    take: 1,
    select: {
      id: true,
      checksum: true,
      fetchedAt: true,
      processingStatus: true,
    },
  },
  jobs: {
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: 1,
    select: {
      id: true,
      trigger: true,
      status: true,
      attempt: true,
      errorCode: true,
      createdAt: true,
      completedAt: true,
    },
  },
  _count: { select: { revisions: true, facts: true, chunks: true } },
} satisfies Prisma.AssistantKnowledgeSourceInclude;

type SourceHealthRecord = Prisma.AssistantKnowledgeSourceGetPayload<{
  include: typeof sourceHealthInclude;
}>;

@Injectable()
export class AssistantSourceRegistryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: AssistantSourceConnectorRegistry,
  ) {}

  async list() {
    const sources = await this.prisma.assistantKnowledgeSource.findMany({
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: sourceHealthInclude,
    });
    return {
      items: sources.map((source) => this.serialize(source)),
      connectors: this.connectors.list(),
      pilot: { maximumProjects: maximumPilotProjects, maximumDevelopers: maximumPilotDevelopers },
    };
  }

  async register(actorId: string, body: unknown) {
    const input = this.parseCreateInput(body);
    const source = await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext('assistant-source-registry-pilot'))
      `);
      const existing = await transaction.assistantKnowledgeSource.findUnique({
        where: { canonicalUrl: input.canonicalUrl },
        include: sourceHealthInclude,
      });
      if (existing) {
        if (this.matchesCreateInput(existing, input)) return existing;
        throw new ConflictException('ASSISTANT_SOURCE_CANONICAL_URL_EXISTS');
      }
      await this.assertPilotCapacity(transaction, input.projectKey, input.developerKey);
      return transaction.assistantKnowledgeSource.create({
        data: {
          ...input,
          createdByUserId: actorId,
          nextRefreshAt: input.state === AssistantKnowledgeSourceState.ACTIVE ? new Date() : null,
        },
        include: sourceHealthInclude,
      });
    });
    return { source: this.serialize(source) };
  }

  async update(sourceIdValue: unknown, body: unknown) {
    const sourceId = this.parseUuid(sourceIdValue, 'sourceId');
    const input = this.parseUpdateInput(body);
    const existing = await this.prisma.assistantKnowledgeSource.findUnique({
      where: { id: sourceId },
      select: { id: true, type: true },
    });
    if (!existing) throw new NotFoundException('ASSISTANT_SOURCE_NOT_FOUND');
    if (input.state !== undefined) {
      if (officialTypes.has(existing.type) && input.state === AssistantKnowledgeSourceState.DISABLED) {
        throw new BadRequestException('ASSISTANT_SOURCE_OFFICIAL_CONNECTOR_INVALID');
      }
      if (!officialTypes.has(existing.type) && input.state !== AssistantKnowledgeSourceState.DISABLED) {
        throw new BadRequestException('ASSISTANT_SOURCE_AGGREGATOR_MUST_BE_DISABLED');
      }
    }
    const source = await this.prisma.assistantKnowledgeSource.update({
      where: { id: sourceId },
      data: {
        ...input,
        ...(input.state === AssistantKnowledgeSourceState.ACTIVE ? { nextRefreshAt: new Date() } : {}),
        ...(input.state && input.state !== AssistantKnowledgeSourceState.ACTIVE ? { nextRefreshAt: null } : {}),
      },
      include: sourceHealthInclude,
    });
    return { source: this.serialize(source) };
  }

  async queueManualRefresh(
    sourceIdValue: unknown,
    actorId: string,
    idempotencyKeyValue: unknown,
  ) {
    const sourceId = this.parseUuid(sourceIdValue, 'sourceId');
    const idempotencyKey = this.parseUuid(idempotencyKeyValue, 'Idempotency-Key');
    const source = await this.prisma.assistantKnowledgeSource.findUnique({
      where: { id: sourceId },
      select: { id: true, state: true },
    });
    if (!source) throw new NotFoundException('ASSISTANT_SOURCE_NOT_FOUND');
    if (source.state !== AssistantKnowledgeSourceState.ACTIVE) {
      throw new ConflictException('ASSISTANT_SOURCE_NOT_ACTIVE');
    }
    const job = await this.prisma.assistantSourceJob.upsert({
      where: { sourceId_idempotencyKey: { sourceId, idempotencyKey } },
      update: {},
      create: {
        sourceId,
        trigger: AssistantSourceJobTrigger.MANUAL,
        status: AssistantSourceJobStatus.PENDING,
        idempotencyKey,
        requestedByUserId: actorId,
      },
      select: {
        id: true,
        sourceId: true,
        trigger: true,
        status: true,
        attempt: true,
        maxAttempts: true,
        availableAt: true,
        createdAt: true,
      },
    });
    return { job: serializeDates(job) };
  }

  async queueProjectRefresh(
    projectKeyValue: unknown,
    actorId: string,
    idempotencyKeyValue: unknown,
  ) {
    const projectKey = this.parseOptionalKey(projectKeyValue, 'projectKey');
    if (!projectKey) throw new BadRequestException('ASSISTANT_SOURCE_PROJECTKEY_INVALID');
    const idempotencyKey = this.parseUuid(idempotencyKeyValue, 'Idempotency-Key');
    const sources = await this.prisma.assistantKnowledgeSource.findMany({
      where: {
        projectKey,
        state: AssistantKnowledgeSourceState.ACTIVE,
        type: { in: [...officialTypes] },
      },
      orderBy: [{ priority: 'desc' }, { id: 'asc' }],
      select: { id: true },
    });
    if (sources.length === 0) throw new NotFoundException('ASSISTANT_SOURCE_PROJECT_NOT_FOUND');
    const jobs = await this.prisma.$transaction(sources.map(({ id: sourceId }) => (
      this.prisma.assistantSourceJob.upsert({
        where: { sourceId_idempotencyKey: { sourceId, idempotencyKey } },
        update: {},
        create: {
          sourceId,
          trigger: AssistantSourceJobTrigger.MANUAL,
          status: AssistantSourceJobStatus.PENDING,
          idempotencyKey,
          requestedByUserId: actorId,
        },
        select: {
          id: true,
          sourceId: true,
          trigger: true,
          status: true,
          attempt: true,
          maxAttempts: true,
          availableAt: true,
          createdAt: true,
        },
      })
    )));
    return { projectKey, jobs: jobs.map((job) => serializeDates(job)) };
  }

  private parseCreateInput(body: unknown) {
    if (!isRecord(body)) throw new BadRequestException('ASSISTANT_SOURCE_INPUT_INVALID');
    const type = this.parseEnum(body.type, Object.values(AssistantKnowledgeSourceType), 'type');
    const state = body.state === undefined
      ? officialTypes.has(type) ? AssistantKnowledgeSourceState.ACTIVE : AssistantKnowledgeSourceState.DISABLED
      : this.parseEnum(body.state, Object.values(AssistantKnowledgeSourceState), 'state');
    const canonicalUrl = this.parseCanonicalUrl(body.canonicalUrl);
    const connectorKey = this.parseBoundedString(body.connectorKey, 'connectorKey', 80);
    const connectorConfigJson = this.parseConnectorConfig(body.connectorConfig, canonicalUrl);
    const projectKey = this.parseOptionalKey(body.projectKey, 'projectKey');
    const developerKey = this.parseOptionalKey(body.developerKey, 'developerKey');
    const priority = this.parseInteger(body.priority, 'priority', 1, 1_000, 100);
    const scheduleMinutes = this.parseInteger(body.scheduleMinutes, 'scheduleMinutes', 60, 1_440, 1_440);

    if (type === AssistantKnowledgeSourceType.DEVELOPMENT_PAGE && (!projectKey || !developerKey)) {
      throw new BadRequestException('ASSISTANT_SOURCE_PROJECT_AND_DEVELOPER_REQUIRED');
    }
    if (officialTypes.has(type)) {
      if (connectorKey !== 'OFFICIAL_HTML' || state === AssistantKnowledgeSourceState.DISABLED) {
        throw new BadRequestException('ASSISTANT_SOURCE_OFFICIAL_CONNECTOR_INVALID');
      }
      this.connectors.get(connectorKey);
    } else {
      const expectedConnector = aggregatorConnectors.get(type);
      if (connectorKey !== expectedConnector || state !== AssistantKnowledgeSourceState.DISABLED) {
        throw new BadRequestException('ASSISTANT_SOURCE_AGGREGATOR_MUST_BE_DISABLED');
      }
    }
    return {
      canonicalUrl,
      type,
      state,
      priority,
      scheduleMinutes,
      connectorKey,
      connectorConfigJson: connectorConfigJson as Prisma.InputJsonValue,
      projectKey,
      developerKey,
    };
  }

  private parseUpdateInput(body: unknown) {
    if (!isRecord(body) || Object.keys(body).length === 0) {
      throw new BadRequestException('ASSISTANT_SOURCE_UPDATE_INVALID');
    }
    const allowed = new Set(['state', 'priority', 'scheduleMinutes', 'connectorConfig']);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      throw new BadRequestException('ASSISTANT_SOURCE_UPDATE_INVALID');
    }
    return {
      ...(body.state === undefined ? {} : {
        state: this.parseEnum(body.state, Object.values(AssistantKnowledgeSourceState), 'state'),
      }),
      ...(body.priority === undefined ? {} : {
        priority: this.parseInteger(body.priority, 'priority', 1, 1_000),
      }),
      ...(body.scheduleMinutes === undefined ? {} : {
        scheduleMinutes: this.parseInteger(body.scheduleMinutes, 'scheduleMinutes', 60, 1_440),
      }),
      ...(body.connectorConfig === undefined ? {} : {
        connectorConfigJson: this.parseConnectorConfig(body.connectorConfig) as Prisma.InputJsonValue,
      }),
    };
  }

  private parseConnectorConfig(value: unknown, canonicalUrl?: string) {
    const config = value === undefined ? {} : value;
    if (!isRecord(config) || JSON.stringify(config).length > 8_000) {
      throw new BadRequestException('ASSISTANT_SOURCE_CONNECTOR_CONFIG_INVALID');
    }
    const allowedKeys = new Set(['allowedHosts']);
    if (Object.keys(config).some((key) => !allowedKeys.has(key))) {
      throw new BadRequestException('ASSISTANT_SOURCE_CONNECTOR_CONFIG_INVALID');
    }
    if (config.allowedHosts !== undefined) {
      if (!Array.isArray(config.allowedHosts) || config.allowedHosts.length > 10) {
        throw new BadRequestException('ASSISTANT_SOURCE_CONNECTOR_CONFIG_INVALID');
      }
      for (const host of config.allowedHosts) {
        if (typeof host !== 'string' || !isHostname(host)) {
          throw new BadRequestException('ASSISTANT_SOURCE_CONNECTOR_CONFIG_INVALID');
        }
      }
    }
    if (canonicalUrl && Array.isArray(config.allowedHosts)) {
      const canonicalHostname = new URL(canonicalUrl).hostname.toLocaleLowerCase('en-US');
      if (!config.allowedHosts.some((host) => typeof host === 'string'
        && host.trim().toLocaleLowerCase('en-US') === canonicalHostname)) {
        throw new BadRequestException('ASSISTANT_SOURCE_CANONICAL_HOST_NOT_ALLOWED');
      }
    }
    return config;
  }

  private parseCanonicalUrl(value: unknown) {
    const raw = this.parseBoundedString(value, 'canonicalUrl', 2_048);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new BadRequestException('ASSISTANT_SOURCE_URL_INVALID');
    }
    const allowTestHttp = process.env.NODE_ENV === 'test'
      && process.env.ASSISTANT_SOURCE_ALLOW_PRIVATE_TEST_URLS === 'true';
    if ((url.protocol !== 'https:' && !(allowTestHttp && url.protocol === 'http:'))
      || url.username || url.password || url.hash || !url.hostname) {
      throw new BadRequestException('ASSISTANT_SOURCE_URL_NOT_ALLOWED');
    }
    url.hash = '';
    return url.toString();
  }

  private parseOptionalKey(value: unknown, field: string) {
    if (value === undefined || value === null || value === '') return null;
    const normalized = this.parseBoundedString(value, field, 120).toLocaleLowerCase('ru-RU');
    if (!/^[\p{L}\p{N}](?:[\p{L}\p{N}._-]{0,118}[\p{L}\p{N}])?$/u.test(normalized)) {
      throw new BadRequestException(`ASSISTANT_SOURCE_${field.toLocaleUpperCase('en-US')}_INVALID`);
    }
    return normalized;
  }

  private parseBoundedString(value: unknown, field: string, maximumLength: number) {
    if (typeof value !== 'string') throw new BadRequestException(`${field} is required`);
    const normalized = value.trim();
    if (!normalized || normalized.length > maximumLength) {
      throw new BadRequestException(`${field} is invalid`);
    }
    return normalized;
  }

  private parseInteger(
    value: unknown,
    field: string,
    minimum: number,
    maximum: number,
    fallback?: number,
  ) {
    if (value === undefined && fallback !== undefined) return fallback;
    if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
      throw new BadRequestException(`${field} is invalid`);
    }
    return value as number;
  }

  private parseEnum<Value extends string>(value: unknown, values: Value[], field: string) {
    if (typeof value !== 'string' || !values.includes(value as Value)) {
      throw new BadRequestException(`${field} is invalid`);
    }
    return value as Value;
  }

  private parseUuid(value: unknown, field: string) {
    if (typeof value !== 'string' || !uuidPattern.test(value)) {
      throw new BadRequestException(`${field} is invalid`);
    }
    return value;
  }

  private async assertPilotCapacity(
    transaction: Prisma.TransactionClient,
    projectKey: string | null,
    developerKey: string | null,
  ) {
    const registered = await transaction.assistantKnowledgeSource.findMany({
      where: { type: { in: [...officialTypes] } },
      select: { projectKey: true, developerKey: true },
    });
    const projectKeys = new Set(registered.flatMap(({ projectKey: key }) => key ? [key] : []));
    const developerKeys = new Set(registered.flatMap(({ developerKey: key }) => key ? [key] : []));
    if (projectKey) projectKeys.add(projectKey);
    if (developerKey) developerKeys.add(developerKey);
    if (projectKeys.size > maximumPilotProjects) throw new ConflictException('ASSISTANT_SOURCE_PILOT_PROJECT_LIMIT');
    if (developerKeys.size > maximumPilotDevelopers) throw new ConflictException('ASSISTANT_SOURCE_PILOT_DEVELOPER_LIMIT');
  }

  private matchesCreateInput(source: SourceHealthRecord, input: ReturnType<AssistantSourceRegistryService['parseCreateInput']>) {
    return source.type === input.type
      && source.state === input.state
      && source.priority === input.priority
      && source.scheduleMinutes === input.scheduleMinutes
      && source.connectorKey === input.connectorKey
      && source.projectKey === input.projectKey
      && source.developerKey === input.developerKey
      && JSON.stringify(source.connectorConfigJson) === JSON.stringify(input.connectorConfigJson);
  }

  private serialize(source: SourceHealthRecord) {
    const latestRevision = source.revisions[0] ?? null;
    const latestJob = source.jobs[0] ?? null;
    return serializeDates({
      id: source.id,
      canonicalUrl: source.canonicalUrl,
      type: source.type,
      state: source.state,
      priority: source.priority,
      scheduleMinutes: source.scheduleMinutes,
      connectorKey: source.connectorKey,
      connectorConfig: source.connectorConfigJson,
      projectKey: source.projectKey,
      developerKey: source.developerKey,
      nextRefreshAt: source.nextRefreshAt,
      lastAttemptAt: source.lastAttemptAt,
      lastSuccessAt: source.lastSuccessAt,
      lastIndexedAt: source.lastIndexedAt,
      lastErrorCode: source.lastErrorCode,
      lastErrorMessage: source.lastErrorMessage,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      counts: source._count,
      latestRevision,
      latestJob,
    });
  }
}

function serializeDates<Value>(value: Value): Value {
  if (value instanceof Date) return value.toISOString() as Value;
  if (Array.isArray(value)) return value.map((item) => serializeDates(item)) as Value;
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serializeDates(item)])) as Value;
}

function isHostname(value: string) {
  const normalized = value.trim().toLocaleLowerCase('en-US').replace(/\.$/u, '');
  return normalized.length > 0
    && normalized.length <= 253
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/u.test(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
