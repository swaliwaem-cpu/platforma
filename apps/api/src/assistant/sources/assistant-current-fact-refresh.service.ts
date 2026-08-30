import { Injectable } from '@nestjs/common';
import {
  AssistantKnowledgeSourceState,
  AssistantKnowledgeSourceType,
  AssistantSourceJobStatus,
  AssistantSourceJobTrigger,
  type Prisma,
} from '@prisma/client';
import type { AssistantPageContext } from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../../prisma/prisma.service';
import { readAssistantCurrentFactRefreshMode } from '../assistant-runtime-config';
import { AssistantSourceWorker } from './assistant-source.worker';
import { assistantKnowledgeAuthorityTier } from './assistant-knowledge-policy';

type RefreshStatus = 'COMPLETED' | 'FAILED' | 'DEADLINE' | 'SOURCE_NOT_CONNECTED';

type RegisteredSource = {
  id: string;
  canonicalUrl: string;
  type: AssistantKnowledgeSourceType;
  state: AssistantKnowledgeSourceState;
  priority: number;
  connectorKey: string;
  connectorConfigJson: Prisma.JsonValue;
  projectKey: string | null;
  developerKey: string | null;
};

@Injectable()
export class AssistantCurrentFactRefreshCoordinator {
  constructor(
    private readonly prisma: PrismaService,
    private readonly worker: AssistantSourceWorker,
    private readonly environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  ) {}

  async refreshForRun(input: {
    operationRunId: string;
    context: AssistantPageContext | null;
    preferredSourceId: string | null;
    deadlineAt: Date;
  }): Promise<{ status: RefreshStatus }> {
    if (input.deadlineAt.getTime() <= Date.now()) return { status: 'DEADLINE' };

    const candidates = await this.readCandidates(input);
    const trustedCandidates = candidates
      .filter((candidate) => isTrustedExactHostSource(candidate, this.environment))
      .sort((left, right) => compareSources(left, right, input.preferredSourceId));
    let source: RegisteredSource | undefined;
    for (const candidate of trustedCandidates) {
      if (await this.isSourceInExactScope(candidate, input.context)) {
        source = candidate;
        break;
      }
    }
    if (!source) return { status: 'SOURCE_NOT_CONNECTED' };
    if (readAssistantCurrentFactRefreshMode(this.environment) === 'disabled') {
      return { status: 'FAILED' };
    }

    const job = await this.prisma.assistantSourceJob.upsert({
      where: {
        sourceId_idempotencyKey: {
          sourceId: source.id,
          idempotencyKey: `current-fact:${input.operationRunId}`,
        },
      },
      update: {},
      create: {
        sourceId: source.id,
        trigger: AssistantSourceJobTrigger.MANUAL,
        idempotencyKey: `current-fact:${input.operationRunId}`,
        requestedByUserId: null,
        maxAttempts: 1,
      },
      select: { id: true, sourceId: true, status: true, errorCode: true },
    });
    if (job.status === AssistantSourceJobStatus.COMPLETED) return { status: 'COMPLETED' };
    if (job.status === AssistantSourceJobStatus.FAILED) return { status: 'FAILED' };

    return this.runWithinDeadline(job.id, input.deadlineAt);
  }

  private readCandidates(input: {
    preferredSourceId: string | null;
    context: AssistantPageContext | null;
  }) {
    if (!input.preferredSourceId
      && input.context?.kind !== 'OBJECT'
      && input.context?.kind !== 'DEVELOPER') return Promise.resolve([]);
    const baseWhere: Prisma.AssistantKnowledgeSourceWhereInput = {
      state: AssistantKnowledgeSourceState.ACTIVE,
      type: {
        in: [
          AssistantKnowledgeSourceType.DEVELOPMENT_PAGE,
          AssistantKnowledgeSourceType.DEVELOPER_PROMOTION,
          AssistantKnowledgeSourceType.BANK_PROMOTION,
        ],
      },
    };
    const candidateFilters: Array<{
      where: Prisma.AssistantKnowledgeSourceWhereInput;
      take: number;
    }> = [];
    if (input.preferredSourceId) {
      candidateFilters.push({ where: { id: input.preferredSourceId }, take: 1 });
    }
    if (input.context?.kind === 'OBJECT' || input.context?.kind === 'DEVELOPER') {
      candidateFilters.push({ where: scopeWhere(input.context), take: 20 });
    }
    return Promise.all(candidateFilters.map(({ where, take }) => (
      this.prisma.assistantKnowledgeSource.findMany({
        where: { ...baseWhere, ...where },
        select: {
          id: true,
          canonicalUrl: true,
          type: true,
          state: true,
          priority: true,
          connectorKey: true,
          connectorConfigJson: true,
          projectKey: true,
          developerKey: true,
        },
        orderBy: [{ priority: 'desc' }, { id: 'asc' }],
        take,
      })
    ))).then((batches) => [
      ...new Map(batches.flat().map((candidate) => [candidate.id, candidate])).values(),
    ]);
  }

  private async isSourceInExactScope(
    source: RegisteredSource,
    context: AssistantPageContext | null,
  ) {
    if (context?.kind === 'OBJECT') {
      if (source.projectKey === context.key) return true;
      if (source.projectKey !== null || source.developerKey === null
        || (source.type !== AssistantKnowledgeSourceType.DEVELOPER_PROMOTION
          && source.type !== AssistantKnowledgeSourceType.BANK_PROMOTION)) return false;
      const projectSource = await this.prisma.assistantKnowledgeSource.findFirst({
        where: {
          projectKey: context.key,
          developerKey: source.developerKey,
          type: AssistantKnowledgeSourceType.DEVELOPMENT_PAGE,
          state: AssistantKnowledgeSourceState.ACTIVE,
        },
        select: { id: true },
      });
      return projectSource !== null;
    }
    if (context?.kind === 'DEVELOPER') return source.developerKey === context.key;
    return true;
  }

  private async runWithinDeadline(jobId: string, deadlineAt: Date): Promise<{ status: RefreshStatus }> {
    const execution = this.worker.runTargetedJob(jobId, new Date())
      .then((result) => ({
        status: result.status === AssistantSourceJobStatus.COMPLETED
          ? 'COMPLETED' as const
          : result.status === AssistantSourceJobStatus.FAILED
            ? 'FAILED' as const
            : 'RUNNING' as const,
      }))
      .catch(() => ({ status: 'FAILED' as const }));
    try {
      const initial = await resolveBeforeDeadline(execution, deadlineAt);
      if (initial === deadlineSignal) return { status: 'DEADLINE' };
      if (initial.status === 'COMPLETED') return { status: 'COMPLETED' };
      if (initial.status === 'FAILED') return { status: 'FAILED' };
      return this.waitForTerminalJob(jobId, deadlineAt);
    } catch {
      return { status: 'FAILED' };
    }
  }

  private async waitForTerminalJob(jobId: string, deadlineAt: Date): Promise<{ status: RefreshStatus }> {
    while (deadlineAt.getTime() > Date.now()) {
      const job = await resolveBeforeDeadline(this.prisma.assistantSourceJob.findUnique({
        where: { id: jobId },
        select: { status: true, errorCode: true },
      }), deadlineAt);
      if (job === deadlineSignal) return { status: 'DEADLINE' };
      if (!job || job.status === AssistantSourceJobStatus.FAILED) return { status: 'FAILED' };
      if (job.status === AssistantSourceJobStatus.COMPLETED) return { status: 'COMPLETED' };
      await new Promise((resolve) => setTimeout(resolve, Math.min(
        25,
        Math.max(0, deadlineAt.getTime() - Date.now()),
      )));
    }
    return { status: 'DEADLINE' };
  }
}

const deadlineSignal = Symbol('assistant-current-fact-deadline');

async function resolveBeforeDeadline<T>(operation: Promise<T>, deadlineAt: Date) {
  const remainingMs = deadlineAt.getTime() - Date.now();
  if (remainingMs <= 0) return deadlineSignal;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<typeof deadlineSignal>((resolve) => {
        timer = setTimeout(() => resolve(deadlineSignal), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function scopeWhere(context: AssistantPageContext | null): Prisma.AssistantKnowledgeSourceWhereInput {
  if (context?.kind === 'OBJECT') return { projectKey: context.key };
  if (context?.kind === 'DEVELOPER') return { developerKey: context.key };
  return {};
}

function isTrustedExactHostSource(
  source: RegisteredSource,
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  if (source.state !== AssistantKnowledgeSourceState.ACTIVE || source.connectorKey !== 'OFFICIAL_HTML') return false;
  try {
    const url = new URL(source.canonicalUrl);
    const allowsPrivateTestUrl = environment.NODE_ENV === 'test'
      && environment.ASSISTANT_SOURCE_ALLOW_PRIVATE_TEST_URLS === 'true';
    if ((url.protocol !== 'https:' && !(allowsPrivateTestUrl && url.protocol === 'http:'))
      || url.username || url.password || url.hash) return false;
    if (!isRecord(source.connectorConfigJson) || !Array.isArray(source.connectorConfigJson.allowedHosts)) return false;
    const allowedHosts = source.connectorConfigJson.allowedHosts
      .filter((host): host is string => typeof host === 'string')
      .map((host) => host.trim().toLocaleLowerCase('en-US'));
    return allowedHosts.includes(url.hostname.toLocaleLowerCase('en-US'));
  } catch {
    return false;
  }
}

function compareSources(
  left: RegisteredSource,
  right: RegisteredSource,
  preferredSourceId: string | null,
) {
  const preferred = Number(right.id === preferredSourceId) - Number(left.id === preferredSourceId);
  if (preferred !== 0) return preferred;
  const authority = assistantKnowledgeAuthorityTier({ sourceType: right.type })
    - assistantKnowledgeAuthorityTier({ sourceType: left.type });
  if (authority !== 0) return authority;
  const priority = right.priority - left.priority;
  return priority || left.id.localeCompare(right.id, 'en-US');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
