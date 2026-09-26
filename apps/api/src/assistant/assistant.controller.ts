import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type {
  AssistantAdminTurnResponse,
  AssistantAdminTurnsResponse,
  AssistantAskInput,
  AssistantJobResponse,
  AssistantTurnFeedbackInput,
  AssistantUsageResponse,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import type { AuthenticatedUser, RequestWithAuth } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { type AssistantTurnListQuery, AssistantTurnLogService } from './assistant-turn-log.service';
import { AssistantService, isAssistantEnabledForActor } from './assistant.service';

@Injectable()
export class AssistantFeatureGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<RequestWithAuth>();
    if (isAssistantEnabledForActor(request.user)) return true;
    throw new ServiceUnavailableException('ASSISTANT_UNAVAILABLE');
  }
}

@Controller('assistant')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('objects:read')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly turnLog: AssistantTurnLogService,
  ) {}

  @Get('config')
  getConfig(@CurrentUser() actor: AuthenticatedUser) {
    return this.assistant.getConfig(actor);
  }

  @Post('jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(AssistantFeatureGuard)
  async startJob(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: AssistantAskInput,
  ): Promise<AssistantJobResponse> {
    return { job: await this.assistant.startJob(actor, body) };
  }

  @Get('jobs/:jobId')
  @UseGuards(AssistantFeatureGuard)
  getJob(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('jobId', new ParseUUIDPipe()) jobId: string,
  ): AssistantJobResponse {
    return { job: this.assistant.getJob(actor, jobId) };
  }

  @Post('turns/:turnId/feedback')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AssistantFeatureGuard)
  async rateTurn(
    @CurrentUser() actor: AuthenticatedUser,
    @Param('turnId', new ParseUUIDPipe()) turnId: string,
    @Body() body: AssistantTurnFeedbackInput,
  ): Promise<void> {
    await this.turnLog.rate(actor, turnId, body);
  }
}

// The turn log and the spend are for admins only, whatever the assistant rollout stage.
@Controller('assistant/admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('admin:access')
export class AssistantAdminController {
  constructor(private readonly turnLog: AssistantTurnLogService) {}

  @Get('turns')
  listTurns(@Query() query: AssistantTurnListQuery): Promise<AssistantAdminTurnsResponse> {
    return this.turnLog.listTurns(query);
  }

  @Get('turns/:turnId')
  getTurn(@Param('turnId', new ParseUUIDPipe()) turnId: string): Promise<AssistantAdminTurnResponse> {
    return this.turnLog.getTurn(turnId);
  }

  @Get('usage')
  getUsage(@Query('days') days?: string): Promise<AssistantUsageResponse> {
    return this.turnLog.usage(days);
  }
}
