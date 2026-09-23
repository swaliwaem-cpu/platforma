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
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import type { AssistantAskInput, AssistantJobResponse } from '@platforma/shared' with { 'resolution-mode': 'import' };

import type { AuthenticatedUser, RequestWithAuth } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
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
  constructor(private readonly assistant: AssistantService) {}

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
}
