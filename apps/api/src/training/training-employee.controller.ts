import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';

import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TrainingAttemptService } from './training-attempt.service';
import { TrainingFeatureGuard } from './training-runtime-config';
import { TrainingTelegramService } from './training-telegram.service';
import {
  parseStartTrainingAttemptInput,
  parseSubmitTrainingAnswerInput,
  parseUuid,
} from './training.validation';

@Controller('training')
@UseGuards(TrainingFeatureGuard, JwtAuthGuard, PermissionsGuard)
@RequirePermissions('training:participate')
export class TrainingEmployeeController {
  constructor(
    private readonly attempts: TrainingAttemptService,
    private readonly telegram: TrainingTelegramService,
  ) {}

  @Get('telegram/account')
  async getTelegramAccount(@CurrentUser() actor: AuthenticatedUser) {
    return this.telegram.getAccountState(actor.id);
  }

  @Get('projects')
  async listProjects(@CurrentUser() actor: AuthenticatedUser) {
    return this.attempts.listEmployeeProjects(actor.id);
  }

  @Post('projects/:projectId/attempts')
  async startAttempt(
    @Param('projectId') projectId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.attempts.startAttempt(
      parseUuid(projectId, 'projectId'),
      actor.id,
      parseStartTrainingAttemptInput(body, idempotencyKey),
    );
  }

  @Post('projects/:projectId/telegram-link')
  async createTelegramLink(
    @Param('projectId') projectId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.telegram.createProjectLink(
      actor.id,
      parseUuid(projectId, 'projectId'),
    );
  }

  @Get('attempts')
  async listAttempts(@CurrentUser() actor: AuthenticatedUser) {
    return this.attempts.listEmployeeAttempts(actor.id);
  }

  @Get('attempts/:attemptId')
  async getAttempt(
    @Param('attemptId') attemptId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.attempts.getEmployeeAttempt(parseUuid(attemptId, 'attemptId'), actor.id);
  }

  @Post('attempts/:attemptId/answers')
  async submitAnswer(
    @Param('attemptId') attemptId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.attempts.submitAnswer(
      parseUuid(attemptId, 'attemptId'),
      actor.id,
      parseSubmitTrainingAnswerInput(body),
    );
  }
}
