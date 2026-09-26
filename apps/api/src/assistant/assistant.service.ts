import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import type {
  AssistantAnswer,
  AssistantAskInput,
  AssistantChatTurn,
  AssistantConfigResponse,
  AssistantJob,
} from '@platforma/shared' with { 'resolution-mode': 'import' };
import { ObjectStatus } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { createAssistantAgentTelemetry, runAssistantAgent } from './assistant-agent';
import { AssistantCatalogTools } from './assistant-catalog.tools';
import { AssistantLlmClient, AssistantLlmError, resolveAssistantModel } from './assistant-llm.client';
import { AssistantTurnLogService } from './assistant-turn-log.service';
import { AssistantWebTools } from './assistant-web.tools';

// Assistant turns run in the background inside the api process; the browser polls them.
// Jobs live in memory only: a restart drops unfinished turns and the chat shows an error.

const jobDeadlineMs = 150_000;
const finishedJobTtlMs = 15 * 60_000;
const maxMessages = 30;
const maxMessageChars = 4_000;

type StoredJob = AssistantJob & {
  ownerId: string;
  finishedAt: number | null;
  controller: AbortController;
};

@Injectable()
export class AssistantService implements OnModuleDestroy {
  private readonly logger = new Logger(AssistantService.name);
  private readonly jobs = new Map<string, StoredJob>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: AssistantLlmClient,
    private readonly catalog: AssistantCatalogTools,
    private readonly web: AssistantWebTools,
    private readonly turnLog: AssistantTurnLogService,
  ) {}

  onModuleDestroy() {
    this.jobs.forEach((job) => job.controller.abort());
  }

  getConfig(actor: AuthenticatedUser): AssistantConfigResponse {
    return {
      enabled: isAssistantEnabledForActor(actor),
      webSearchEnabled: this.web.isSearchConfigured(),
    };
  }

  async startJob(actor: AuthenticatedUser, input: AssistantAskInput): Promise<AssistantJob> {
    this.sweep();
    const history = readHistory(input);
    if (!this.llm.isConfigured()) throw new ServiceUnavailableException('ASSISTANT_LLM_NOT_CONFIGURED');
    if ([...this.jobs.values()].some((job) => job.ownerId === actor.id && job.status === 'RUNNING')) {
      throw new ConflictException('ASSISTANT_JOB_ALREADY_RUNNING');
    }

    const job: StoredJob = {
      id: randomUUID(),
      ownerId: actor.id,
      status: 'RUNNING',
      steps: ['Понимаю запрос'],
      answer: null,
      error: null,
      createdAt: new Date().toISOString(),
      turnId: null,
      finishedAt: null,
      controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    const pageProject = await this.findPageProject(input.pageObjectSlug);
    const conversationId = typeof input.conversationId === 'string' && uuidPattern.test(input.conversationId)
      ? input.conversationId
      : null;
    void this.run(job, history, pageProject, conversationId);
    return toPublicJob(job);
  }

  getJob(actor: AuthenticatedUser, jobId: string): AssistantJob {
    const job = this.jobs.get(jobId);
    if (!job || job.ownerId !== actor.id) throw new NotFoundException('ASSISTANT_JOB_NOT_FOUND');
    return toPublicJob(job);
  }

  private async run(
    job: StoredJob,
    history: AssistantChatTurn[],
    pageProject: { title: string; projectId: string } | null,
    conversationId: string | null,
  ) {
    const startedAt = Date.now();
    const occurredAt = new Date(startedAt);
    const deadline = setTimeout(() => job.controller.abort(), jobDeadlineMs);
    const telemetry = createAssistantAgentTelemetry();
    const logTurn = async (answer: AssistantAnswer | null, failure: string | null) => {
      try {
        await this.turnLog.record({
          id: job.id,
          userId: job.ownerId,
          conversationId,
          question: history.at(-1)?.content ?? '',
          answer,
          telemetry,
          model: resolveAssistantModel(),
          durationMs: Date.now() - startedAt,
          errorCode: failure,
          occurredAt,
        });
        return job.id;
      } catch (error) {
        // The broker still gets the answer; only rating it is off.
        this.logger.warn(`assistant turn ${job.id} was not logged: ${errorCode(error)}`);
        return null;
      }
    };
    try {
      const result = await runAssistantAgent(
        { llm: this.llm, catalog: this.catalog, web: this.web },
        {
          history,
          pageProject,
          now: occurredAt,
          signal: job.controller.signal,
          telemetry,
          onStep: (label) => {
            if (job.steps.at(-1) !== label) job.steps.push(label);
          },
        },
      );
      const turnId = await logTurn(result.answer, null);
      job.answer = { ...result.answer, turnId };
      job.turnId = turnId;
      job.status = 'COMPLETED';
      const { trace: _trace, ...usage } = telemetry;
      this.logger.log(`assistant job ${job.id} done in ${Date.now() - startedAt} ms: ${JSON.stringify(usage)}`);
    } catch (error) {
      job.turnId = await logTurn(null, job.controller.signal.aborted ? 'ASSISTANT_JOB_DEADLINE' : errorCode(error));
      job.status = 'FAILED';
      job.error = describeFailure(error, job.controller.signal.aborted);
      this.logger.warn(`assistant job ${job.id} failed in ${Date.now() - startedAt} ms: ${errorCode(error)}`);
    } finally {
      clearTimeout(deadline);
      job.finishedAt = Date.now();
    }
  }

  private async findPageProject(slug: string | null | undefined) {
    const value = typeof slug === 'string' ? slug.trim() : '';
    if (!value || value.length > 300) return null;
    const object = await this.prisma.realEstateObject.findFirst({
      where: { slug: value, status: ObjectStatus.PUBLISHED, deletedAt: null },
      select: { id: true, title: true },
    });
    return object ? { projectId: object.id, title: object.title } : null;
  }

  private sweep() {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.finishedAt !== null && now - job.finishedAt > finishedJobTtlMs) this.jobs.delete(id);
    }
  }
}

export function isAssistantEnabledForActor(
  actor: Pick<AuthenticatedUser, 'id' | 'permissions'> | undefined,
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
) {
  if (!actor || environment.ASSISTANT_MODULE_ENABLED !== 'true') return false;
  const permissions = new Set(actor.permissions);
  if (!permissions.has('objects:read')) return false;
  if (
    permissions.has('admin:access')
    || permissions.has('assistant:audit:read')
    || permissions.has('assistant:sources:manage')
  ) return true;
  const stage = (environment.ASSISTANT_ROLLOUT_STAGE ?? 'ADMINS').trim().toUpperCase();
  if (stage === 'ALL') return true;
  if (stage === 'PILOT') {
    return (environment.ASSISTANT_PILOT_USER_IDS ?? '').split(',').map((id) => id.trim()).includes(actor.id);
  }
  return false;
}

function readHistory(input: AssistantAskInput | undefined): AssistantChatTurn[] {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const history = messages.slice(-maxMessages).flatMap((message): AssistantChatTurn[] => {
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) return [];
    const content = typeof message.content === 'string' ? message.content.trim().slice(0, maxMessageChars) : '';
    return content ? [{ role: message.role, content }] : [];
  });
  if (history.at(-1)?.role !== 'user') throw new BadRequestException('ASSISTANT_MESSAGE_REQUIRED');
  return history;
}

function toPublicJob(job: StoredJob): AssistantJob {
  return {
    id: job.id,
    status: job.status,
    steps: [...job.steps],
    answer: job.answer,
    error: job.error,
    createdAt: job.createdAt,
    turnId: job.turnId,
  };
}

function describeFailure(error: unknown, aborted: boolean) {
  if (aborted) return 'Поиск занял слишком много времени. Попробуйте сузить запрос.';
  if (error instanceof AssistantLlmError) {
    return error.code === 'ASSISTANT_LLM_TIMEOUT'
      ? 'Нейросеть не ответила вовремя. Попробуйте ещё раз.'
      : 'Нейросеть сейчас недоступна. Попробуйте ещё раз через минуту.';
  }
  return 'Не получилось выполнить поиск. Попробуйте ещё раз.';
}

function errorCode(error: unknown) {
  if (error instanceof AssistantLlmError) return error.message;
  return error instanceof Error ? error.message.slice(0, 200) : 'UNKNOWN';
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
