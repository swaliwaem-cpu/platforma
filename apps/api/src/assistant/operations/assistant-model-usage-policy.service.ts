import { Injectable, Optional } from '@nestjs/common';

import type {
  AssistantPlannerRequest,
  AssistantPlannerTelemetry,
  AssistantPlannerUsagePolicy,
} from '../assistant-query-planner';
import {
  ASSISTANT_PLANNER_PROMPT_VERSION,
  createAssistantPlannerRequestBody,
} from '../assistant-planner-gateway';
import { estimateAssistantAiCallCost } from './assistant-ai-cost';
import {
  AssistantAiUsageBudgetService,
  readAssistantDailyUsdBudget,
  type AssistantAiUsageReservation,
} from './assistant-ai-usage-budget.service';
import {
  AssistantUsageBudgetService,
  readAssistantBudgetLimit,
  type AssistantUsageReservation,
} from './assistant-usage-budget.service';

type AssistantEnvironment = NodeJS.ProcessEnv | Record<string, string | undefined>;

@Injectable()
export class AssistantModelUsagePolicyService implements AssistantPlannerUsagePolicy {
  private readonly provider: 'fake' | 'openai';
  private readonly perMinuteLimit: number;
  private readonly dailyLimit: number;
  private readonly dailyBudgetUsd: string;

  constructor(
    private readonly budgets: AssistantUsageBudgetService,
    @Optional()
    environment: AssistantEnvironment = process.env,
    private readonly aiBudgets?: AssistantAiUsageBudgetService,
  ) {
    this.provider = (environment.ASSISTANT_AI_MODE ?? 'fake').trim().toLocaleLowerCase('en-US') === 'openai'
      ? 'openai'
      : 'fake';
    this.perMinuteLimit = readAssistantBudgetLimit(
      environment.ASSISTANT_MODEL_REQUESTS_PER_MINUTE,
      this.provider === 'fake' ? 10_000 : 60,
      1,
      1_000_000,
      'ASSISTANT_MODEL_REQUESTS_PER_MINUTE_INVALID',
    );
    this.dailyLimit = readAssistantBudgetLimit(
      environment.ASSISTANT_MODEL_REQUESTS_PER_DAY,
      this.provider === 'fake' ? 1_000_000 : 5_000,
      1,
      10_000_000,
      'ASSISTANT_MODEL_REQUESTS_PER_DAY_INVALID',
    );
    this.dailyBudgetUsd = readAssistantDailyUsdBudget(
      environment.ASSISTANT_MODEL_DAILY_BUDGET_USD,
      this.provider === 'openai',
    );
  }

  async beforeAttempt(request: AssistantPlannerRequest) {
    const requestReservation = await this.budgets.reserve({
      provider: this.provider,
      model: request.model,
      perMinuteLimit: this.perMinuteLimit,
      dailyLimit: this.dailyLimit,
      errorPrefix: 'ASSISTANT_MODEL',
    });
    if (this.provider === 'fake') return { requestReservation, aiReservation: null };
    let aiReservation: AssistantAiUsageReservation;
    try {
      if (!this.aiBudgets) throw new Error('ASSISTANT_AI_USAGE_BUDGET_SERVICE_REQUIRED');
      const estimated = estimateAssistantAiCallCost({
        model: request.model,
        requestBytes: Buffer.byteLength(
          JSON.stringify(createAssistantPlannerRequestBody(request)),
          'utf8',
        ),
        maxOutputTokens: 2_500,
        maxWebSearchCalls: 0,
      });
      if (estimated.status !== 'PRICED' || estimated.estimatedUsd === null) {
        throw new Error('ASSISTANT_MODEL_COST_UNPRICED');
      }
      aiReservation = await this.aiBudgets.reserve({
        provider: this.provider,
        model: request.model,
        operation: 'PLANNER',
        operationRunId: request.operationRunId ?? 'assistant-planner-missing-run',
        attemptOrdinal: request.attemptOrdinal ?? 1,
        dailyBudgetUsd: this.dailyBudgetUsd,
        reservedCostUsd: estimated.estimatedUsd,
        reasoningEffort: request.reasoningEffort,
        promptVersion: ASSISTANT_PLANNER_PROMPT_VERSION,
        validatorVersion: 'assistant-query-planner-validator-v1',
        isFallback: request.model.endsWith('-terra'),
      });
    } catch (error) {
      try {
        await this.budgets.complete({
          reservation: requestReservation,
          outcome: 'ERROR',
          durationMs: 0,
        });
      } catch {
        // The USD failure remains authoritative; aggregate request telemetry may recover later.
      }
      throw error;
    }
    return { requestReservation, aiReservation };
  }

  async afterAttempt(reservationValue: unknown, telemetry: AssistantPlannerTelemetry) {
    const reservation = reservationValue as {
      requestReservation: AssistantUsageReservation;
      aiReservation: AssistantAiUsageReservation | null;
    };
    let settlementError: unknown;
    if (reservation.aiReservation) {
      try {
        await this.aiBudgets!.settle({
          reservation: reservation.aiReservation,
          actualModel: telemetry.model,
          outcome: telemetry.outcome,
          errorCode: telemetry.errorCode,
          inputTokens: telemetry.inputTokens,
          cachedInputTokens: telemetry.cachedInputTokens,
          cacheWriteInputTokens: telemetry.cacheWriteInputTokens,
          outputTokens: telemetry.outputTokens,
          reasoningTokens: telemetry.reasoningTokens,
          totalTokens: telemetry.totalTokens,
          webSearchCalls: telemetry.webSearchCalls,
          durationMs: telemetry.durationMs,
        });
      } catch (error) {
        settlementError = error;
      }
    }
    try {
      await this.budgets.complete({
        reservation: reservation.requestReservation,
        outcome: telemetry.outcome,
        inputTokens: telemetry.inputTokens,
        outputTokens: telemetry.outputTokens,
        reasoningTokens: telemetry.reasoningTokens,
        totalTokens: telemetry.totalTokens,
        durationMs: telemetry.durationMs,
      });
    } catch (error) {
      if (!settlementError) settlementError = error;
    }
    if (settlementError) throw settlementError;
  }
}
