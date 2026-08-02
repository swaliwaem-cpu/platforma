import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';

import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TrainingAttemptService } from './training-attempt.service';
import { TrainingProjectService } from './training-project.service';
import { TrainingProjectAccessService } from './training-project-access.service';
import { TrainingReviewService } from './training-review.service';
import {
  parseCreateTrainingProjectInput,
  parseBulkTrainingProjectAssignmentsInput,
  parseTrainingAssignmentUsersQuery,
  parseTrainingProjectAccessModeInput,
  parseTrainingAvailabilityInput,
  parseReviewTrainingAttemptInput,
  parseUpdateTrainingProjectDraftInput,
  parseUuid,
} from './training.validation';

@Controller('training/admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TrainingAdminController {
  constructor(
    private readonly projects: TrainingProjectService,
    private readonly projectAccess: TrainingProjectAccessService,
    private readonly attempts: TrainingAttemptService,
    private readonly reviews: TrainingReviewService,
  ) {}

  @Get('projects')
  @RequirePermissions('training:projects:manage')
  async listProjects() {
    return this.projects.listAdminProjects();
  }

  @Post('projects')
  @RequirePermissions('training:projects:manage')
  async createProject(@Body() body: Record<string, unknown>) {
    return this.projects.createProject(parseCreateTrainingProjectInput(body));
  }

  @Get('projects/:projectId')
  @RequirePermissions('training:projects:manage')
  async getProject(@Param('projectId') projectId: string) {
    return this.projects.getAdminProject(parseUuid(projectId, 'projectId'));
  }

  @Get('projects/:projectId/assignment-users')
  @RequirePermissions('training:projects:manage')
  async listAssignmentUsers(
    @Param('projectId') projectId: string,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.projectAccess.listAssignmentUsers(
      parseUuid(projectId, 'projectId'),
      parseTrainingAssignmentUsersQuery(query),
    );
  }

  @Post('projects/:projectId/assignments/bulk')
  @RequirePermissions('training:projects:manage')
  async bulkAssignments(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.projectAccess.bulkAssignments(
      parseUuid(projectId, 'projectId'),
      actor.id,
      parseBulkTrainingProjectAssignmentsInput(body),
    );
  }

  @Patch('projects/:projectId')
  @RequirePermissions('training:projects:manage')
  async updateProject(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const parsedProjectId = parseUuid(projectId, 'projectId');

    if (Object.prototype.hasOwnProperty.call(body, 'isOpen')) {
      return this.projects.setAvailability(
        parsedProjectId,
        parseTrainingAvailabilityInput(body).isOpen,
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(body, 'accessMode') &&
      Object.keys(body).length === 1
    ) {
      const { accessMode } = parseTrainingProjectAccessModeInput(body);
      await this.projectAccess.setAccessMode(parsedProjectId, actor.id, accessMode);
      return this.projects.getAdminProject(parsedProjectId);
    }

    return this.projects.updateDraft(
      parsedProjectId,
      parseUpdateTrainingProjectDraftInput(body),
      actor.id,
    );
  }

  @Post('projects/:projectId/publish')
  @RequirePermissions('training:projects:manage')
  async publishProject(@Param('projectId') projectId: string) {
    return this.projects.publishProject(parseUuid(projectId, 'projectId'));
  }

  @Get('attempts')
  @RequirePermissions('training:results:read')
  async listAttempts() {
    return this.attempts.listAdminAttempts();
  }

  @Get('attempts/:attemptId')
  @RequirePermissions('training:results:read')
  async getAttempt(@Param('attemptId') attemptId: string) {
    return this.attempts.getAdminAttempt(parseUuid(attemptId, 'attemptId'));
  }

  @Post('attempts/:attemptId/review')
  @RequirePermissions('training:results:review')
  async reviewAttempt(
    @Param('attemptId') attemptId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.reviews.reviewAttempt(
      parseUuid(attemptId, 'attemptId'),
      actor.id,
      parseReviewTrainingAttemptInput(body),
    );
  }
}
