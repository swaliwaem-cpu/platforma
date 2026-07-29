import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TrainingAssignmentsService } from './training-assignments.service';
import type { TrainingAuditRequest } from './training-content.service';
import { TrainingFeatureGuard } from './training-feature.guard';

@Controller('training/admin')
@UseGuards(JwtAuthGuard, PermissionsGuard, TrainingFeatureGuard)
@RequirePermissions('training:projects:manage')
export class TrainingAssignmentsController {
  constructor(
    private readonly assignments: TrainingAssignmentsService,
  ) {}

  @Get('assignees')
  listCandidates(@Query() query: Record<string, unknown>) {
    return this.assignments.listCandidates(query);
  }

  @Get('projects/:projectId/assignments')
  getAssignments(@Param('projectId') projectId: string) {
    return this.assignments.getAssignments(projectId);
  }

  @Patch('projects/:projectId/audience')
  updateAudience(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.assignments.updateAudience(
      projectId,
      body,
      actor,
      request,
    );
  }

  @Put('projects/:projectId/assignments')
  replaceAssignments(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAuditRequest,
  ) {
    return this.assignments.replaceAssignments(
      projectId,
      body,
      actor,
      request,
    );
  }
}
