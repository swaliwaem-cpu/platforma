import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TrainingOperationsService } from './training-operations.service';

@Controller('training/admin/operations')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TrainingOperationsController {
  constructor(private readonly operations: TrainingOperationsService) {}

  @Get()
  @RequirePermissions('training:operations:read')
  getSummary() {
    return this.operations.getSummary();
  }

  @Get('summary')
  @RequirePermissions('training:operations:read')
  getSummaryAlias() {
    return this.operations.getSummary();
  }

  @Post('jobs/:jobId/retry')
  @RequirePermissions('training:operations:manage')
  retryJob(
    @Param('jobId') jobId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: Record<string, unknown>,
  ) {
    return this.operations.retryJob(jobId, actor.id, body.reason);
  }
}
