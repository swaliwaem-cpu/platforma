import { Injectable, Optional } from '@nestjs/common';

import type {
  AssistantPlannerRequest,
  AssistantPlannerTelemetry,
  AssistantPlannerUsagePolicy,
} from '../assistant-query-planner';
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

  constructor(
    private readonly budgets: AssistantUsageBudgetService,
    @Optional()
    environment: AssistantEnvironment = process.env,
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
  }

  beforeAttempt(request: AssistantPlannerRequest) {
    return this.budgets.reserve({
      provider: this.provider,
      model: request.model,
      perMinuteLimit: this.perMinuteLimit,
      dailyLimit: this.dailyLimit,
      errorPrefix: 'ASSISTANT_MODEL',
    });
  }

  async afterAttempt(reservationValue: unknown, telemetry: AssistantPlannerTelemetry) {
    const reservation = reservationValue as AssistantUsageReservation;
    await this.budgets.complete({
      reservation,
      outcome: telemetry.outcome,
      inputTokens: telemetry.inputTokens,
      outputTokens: telemetry.outputTokens,
      reasoningTokens: telemetry.reasoningTokens,
      totalTokens: telemetry.totalTokens,
      durationMs: telemetry.durationMs,
    });
  }
}
