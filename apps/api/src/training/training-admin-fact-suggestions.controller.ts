import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TrainingFactSuggestionsService } from './fact-suggestions/training-fact-suggestions.service';
import type { TrainingAuditRequest } from './training-content.service';
import { TrainingFeatureGuard } from './training-feature.guard';

@Controller('training/admin')
@UseGuards(JwtAuthGuard, PermissionsGuard, TrainingFeatureGuard)
@RequirePermissions('training:projects:manage')
export class TrainingAdminFactSuggestionsController {
  constructor(
    private readonly factSuggestions: TrainingFactSuggestionsService,
  ) {}

  @Post('versions/:versionId/fact-suggestion-runs')
  async createFactSuggestionRun(
    @Param('versionId') versionId: string,
    @Body() body: Record<string, unknown>,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.factSuggestions.createRun(
      versionId,
      body,
      actor,
      request,
      idempotencyKey,
    );
  }

  @Get('versions/:versionId/fact-suggestion-runs/latest')
  async getLatestFactSuggestionRun(@Param('versionId') versionId: string) {
    return this.factSuggestions.getLatestRun(versionId);
  }

  @Get('versions/:versionId/fact-suggestions')
  async listFactSuggestions(@Param('versionId') versionId: string) {
    return this.factSuggestions.listSuggestions(versionId);
  }

  @Post(
    'versions/:versionId/fact-suggestions/:suggestionId/accept',
  )
  async acceptFactSuggestion(
    @Param('versionId') versionId: string,
    @Param('suggestionId') suggestionId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.factSuggestions.acceptSuggestion(
      versionId,
      suggestionId,
      body,
      actor,
      request,
    );
  }

  @Post(
    'versions/:versionId/fact-suggestions/:suggestionId/reject',
  )
  async rejectFactSuggestion(
    @Param('versionId') versionId: string,
    @Param('suggestionId') suggestionId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.factSuggestions.rejectSuggestion(
      versionId,
      suggestionId,
      body,
      actor,
      request,
    );
  }
}
