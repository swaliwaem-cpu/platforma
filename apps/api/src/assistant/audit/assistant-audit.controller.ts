import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';

import { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/current-user.decorator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../auth/permissions.decorator';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { AssistantFeatureGuard } from '../assistant-runtime-config';
import { AssistantAuditService } from './assistant-audit.service';

@Controller('assistant/audit')
@UseGuards(JwtAuthGuard, PermissionsGuard, AssistantFeatureGuard)
@RequirePermissions('assistant:audit:read')
export class AssistantAuditController {
  constructor(private readonly audit: AssistantAuditService) {}

  @Get('runs')
  listRuns(@Query() query: Record<string, unknown>) {
    return this.audit.listRuns(query);
  }

  @Get('runs/:runId')
  getRun(@Param('runId') runId: string) {
    return this.audit.getRun(runId);
  }

  @Patch('reviews/:reviewId')
  review(
    @Param('reviewId') reviewId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: unknown,
  ) {
    return this.audit.review(reviewId, actor.id, body);
  }

  @Get('sources')
  listSources() {
    return this.audit.listSources();
  }

  @Get('geo/operations')
  listGeoOperations(@Query() query: Record<string, unknown>) {
    return this.audit.listGeoOperations(query);
  }

  @Get('geo/aliases')
  listAliases() {
    return this.audit.listAliases();
  }

  @Get('metrics')
  listMetrics(@Query() query: Record<string, unknown>) {
    return this.audit.listUsageMetrics(query);
  }
}
