import { AsyncLocalStorage } from 'node:async_hooks';

import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { isAssistantGeoProviderEnabled } from '../assistant-runtime-config';
import {
  AssistantUsageBudgetError,
  AssistantUsageBudgetService,
  readAssistantBudgetLimit,
  type AssistantUsageReservation,
} from '../operations/assistant-usage-budget.service';
import {
  AssistantGeoProviderError,
  FakeAssistantGeoProvider,
  LocationIqGeoProvider,
  type AssistantGeoProvider,
  type AssistantGeoProviderCandidate,
  type AssistantGeoProviderRequest,
} from './assistant-geo-provider';
import {
  AssistantGeoUsageLedgerError,
  AssistantGeoUsageLedgerService,
  type AssistantGeoUsageReservation,
} from './assistant-geo-usage-ledger.service';

type GeoPolicyEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;
type GeoRequestContext = { providerCallCount: number };

export type AssistantGeoProviderSearchResult = {
  candidates: AssistantGeoProviderCandidate[];
  providerCallCount: number;
};

export class AssistantGeoProviderPolicyService {
  private readonly logger = new Logger(AssistantGeoProviderPolicyService.name);
  private readonly providerName: 'fake' | 'locationiq';
  private readonly enabled: boolean;
  private readonly requestsPerSecond: number;
  private readonly dailyBudget: number;
  private readonly circuitFailureThreshold: number;
  private readonly circuitOpenMs: number;
  private readonly cacheRetentionMs: number;
  private readonly perMinuteBudget: number;
  private readonly providerUsesPhysicalRequestLifecycle: boolean;
  private readonly requestContext = new AsyncLocalStorage<GeoRequestContext>();
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private nextRequestAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: AssistantGeoProvider,
    environment: GeoPolicyEnvironment = process.env,
    private readonly now: () => Date = () => new Date(),
    private readonly delay: (milliseconds: number) => Promise<void> = wait,
    private readonly budgets?: AssistantUsageBudgetService,
    private readonly geoUsageLedger?: Pick<AssistantGeoUsageLedgerService, 'reserve' | 'settle'>,
  ) {
    this.enabled = isAssistantGeoProviderEnabled(environment);
    this.providerName = readMode(environment.ASSISTANT_GEO_PROVIDER_MODE);
    if (this.enabled && this.providerName === 'fake' && environment.DEPLOYMENT_ENV === 'production') {
      throw new AssistantGeoProviderError('ASSISTANT_GEO_FAKE_PROVIDER_FORBIDDEN', false);
    }
    this.requestsPerSecond = readInteger(environment.ASSISTANT_GEO_PROVIDER_RPS, 1, 1, 20);
    this.dailyBudget = readProviderPlanInteger(
      environment.ASSISTANT_GEO_PROVIDER_DAILY_BUDGET,
      this.providerName === 'fake' || !this.enabled ? 10_000 : null,
      1,
      1_000_000,
      'ASSISTANT_GEO_PROVIDER_DAILY_BUDGET_REQUIRED',
    );
    this.cacheRetentionMs = readProviderPlanInteger(
      environment.ASSISTANT_GEO_CACHE_TTL_SECONDS,
      this.providerName === 'fake' || !this.enabled ? 86_400 : null,
      60,
      31_536_000,
      'ASSISTANT_GEO_CACHE_TTL_SECONDS_REQUIRED',
    ) * 1_000;
    this.perMinuteBudget = readAssistantBudgetLimit(
      environment.ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE,
      this.providerName === 'fake' ? 10_000 : 60,
      1,
      1_000_000,
      'ASSISTANT_GEO_PROVIDER_REQUESTS_PER_MINUTE_INVALID',
    );
    this.circuitFailureThreshold = readInteger(
      environment.ASSISTANT_GEO_CIRCUIT_FAILURE_THRESHOLD,
      3,
      1,
      20,
    );
    this.circuitOpenMs = readInteger(
      environment.ASSISTANT_GEO_CIRCUIT_OPEN_MS,
      60_000,
      1_000,
      3_600_000,
    );
    this.providerUsesPhysicalRequestLifecycle = provider instanceof LocationIqGeoProvider;
    if (provider instanceof LocationIqGeoProvider) {
      provider.setRequestLifecycle(
        () => this.reservePhysicalAttempt(),
        (reservation, outcome, durationMs, errorCode) => this.recordUsage(
          reservation as AssistantUsageReservation | AssistantGeoUsageReservation | undefined,
          outcome,
          durationMs,
          errorCode,
        ),
      );
    }
  }

  getProviderName() {
    return this.providerName;
  }

  getCacheRetentionMs() {
    return this.cacheRetentionMs;
  }

  async search(request: AssistantGeoProviderRequest): Promise<AssistantGeoProviderCandidate[]> {
    return (await this.searchWithTelemetry(request)).candidates;
  }

  async searchWithTelemetry(request: AssistantGeoProviderRequest): Promise<AssistantGeoProviderSearchResult> {
    const context: GeoRequestContext = { providerCallCount: 0 };
    return this.requestContext.run(context, async () => {
      const startedAt = Date.now();
      if (!this.enabled) {
        throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_DISABLED', false);
      }
      if (this.now().getTime() < this.circuitOpenUntil) {
        this.log('circuit_open', startedAt);
        throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_CIRCUIT_OPEN', true);
      }

      try {
        let candidates: AssistantGeoProviderCandidate[];
        if (this.providerUsesPhysicalRequestLifecycle) {
          candidates = await this.provider.search(request);
        } else {
          const attemptStartedAt = Date.now();
          const reservation = await this.reservePhysicalAttempt();
          try {
            candidates = await this.provider.search(request);
            await this.recordUsage(reservation, 'SUCCESS', Math.max(0, Date.now() - attemptStartedAt), null);
          } catch (error) {
            await this.recordUsage(
              reservation,
              'ERROR',
              Math.max(0, Date.now() - attemptStartedAt),
              error instanceof AssistantGeoProviderError ? error.code : 'ASSISTANT_GEO_PROVIDER_UNAVAILABLE',
            );
            throw error;
          }
        }
        this.consecutiveFailures = 0;
        this.circuitOpenUntil = 0;
        this.log('success', startedAt);
        return { candidates, providerCallCount: context.providerCallCount };
      } catch (error) {
        const providerError = error instanceof AssistantGeoProviderError
          ? error
          : new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_UNAVAILABLE', true);
        providerError.providerCallCount = context.providerCallCount;
        if (providerError.retryable) {
          this.consecutiveFailures += 1;
          if (this.consecutiveFailures >= this.circuitFailureThreshold) {
            this.circuitOpenUntil = this.now().getTime() + this.circuitOpenMs;
          }
        }
        this.log(providerError.code, startedAt, providerError.httpStatus);
        throw providerError;
      }
    });
  }

  private async reservePhysicalAttempt() {
    await this.waitForRateSlot();
    let reservation: AssistantUsageReservation | AssistantGeoUsageReservation | undefined;
    if (this.geoUsageLedger && this.providerName === 'locationiq') {
      try {
        reservation = await this.geoUsageLedger.reserve('locationiq');
      } catch (error) {
        if (error instanceof AssistantGeoUsageLedgerError) {
          throw new AssistantGeoProviderError(error.code, false);
        }
        throw error;
      }
    } else if (this.budgets) {
      try {
        reservation = await this.budgets.reserve({
          provider: this.providerName,
          model: this.providerName === 'locationiq' ? 'locationiq' : 'fake-geo',
          perMinuteLimit: this.perMinuteBudget,
          dailyLimit: this.dailyBudget,
          now: this.now(),
          errorPrefix: 'ASSISTANT_GEO_PROVIDER',
        });
      } catch (error) {
        if (error instanceof AssistantUsageBudgetError) {
          throw new AssistantGeoProviderError(error.code, false);
        }
        throw error;
      }
    } else {
      await this.reserveDailyBudget();
    }
    const context = this.requestContext.getStore();
    if (context) context.providerCallCount += 1;
    return reservation;
  }

  private async recordUsage(
    reservation: AssistantUsageReservation | AssistantGeoUsageReservation | undefined,
    outcome: 'SUCCESS' | 'ERROR',
    durationMs: number,
    errorCode: string | null,
  ) {
    if (!reservation) return;
    if ('id' in reservation && this.geoUsageLedger) {
      try {
        await this.geoUsageLedger.settle(reservation, { outcome, durationMs, errorCode });
      } catch (error) {
        const code = error instanceof AssistantGeoUsageLedgerError
          ? error.code
          : 'ASSISTANT_GEO_USAGE_SETTLEMENT_FAILED';
        throw new AssistantGeoProviderError(code, false);
      }
      return;
    }
    if (!this.budgets) return;
    try {
      await this.budgets.complete({
        reservation,
        outcome,
        durationMs,
      });
    } catch {
      // Per-operation telemetry is still recorded by the resolver.
    }
  }

  private async waitForRateSlot() {
    const nowMs = this.now().getTime();
    const intervalMs = Math.ceil(1_000 / this.requestsPerSecond);
    const reservedAt = Math.max(nowMs, this.nextRequestAt);
    this.nextRequestAt = reservedAt + intervalMs;
    if (reservedAt > nowMs) await this.delay(reservedAt - nowMs);
  }

  private async reserveDailyBudget() {
    const usageDate = this.now().toISOString().slice(0, 10);
    const rows = await this.prisma.$queryRaw<Array<{ requestCount: number }>>(Prisma.sql`
      INSERT INTO "assistant_geo_provider_daily_usage" (
        "provider", "usage_date", "request_count", "updated_at"
      ) VALUES (
        ${this.providerName}, ${usageDate}::date, 1, NOW()
      )
      ON CONFLICT ("provider", "usage_date") DO UPDATE SET
        "request_count" = "assistant_geo_provider_daily_usage"."request_count" + 1,
        "updated_at" = NOW()
      WHERE "assistant_geo_provider_daily_usage"."request_count" < ${this.dailyBudget}
      RETURNING "request_count" AS "requestCount"
    `);
    if (rows.length !== 1) {
      this.log('daily_budget_exhausted', Date.now());
      throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_DAILY_BUDGET_EXHAUSTED', false);
    }
  }

  private log(outcome: string, startedAt: number, httpStatus: number | null = null) {
    this.logger.log(JSON.stringify({
      event: 'assistant_geo_provider',
      provider: this.providerName,
      outcome,
      httpStatus,
      durationMs: Math.max(0, Date.now() - startedAt),
    }));
  }
}

export function createAssistantGeoProvider(environment: GeoPolicyEnvironment = process.env) {
  const mode = readMode(environment.ASSISTANT_GEO_PROVIDER_MODE);
  return mode === 'fake' || !isAssistantGeoProviderEnabled(environment)
    ? new FakeAssistantGeoProvider()
    : new LocationIqGeoProvider(environment);
}

function readMode(value: string | undefined) {
  const normalized = (value ?? 'fake').trim().toLocaleLowerCase('en-US');
  if (normalized === 'fake' || normalized === 'locationiq') return normalized;
  throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_MODE_INVALID', false);
}

function readInteger(value: string | undefined, fallback: number, minimum: number, maximum: number) {
  const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AssistantGeoProviderError('ASSISTANT_GEO_PROVIDER_CONFIG_INVALID', false);
  }
  return parsed;
}

function readProviderPlanInteger(
  value: string | undefined,
  fallback: number | null,
  minimum: number,
  maximum: number,
  requiredCode: string,
) {
  if ((value === undefined || value.trim() === '') && fallback === null) {
    throw new AssistantGeoProviderError(requiredCode, false);
  }
  return readInteger(value, fallback ?? minimum, minimum, maximum);
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
