import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TrainingAttemptService } from './training-attempt.service';
import { TrainingProjectService } from './training-project.service';
import {
  parseCreateTrainingProjectInput,
  parseTrainingAvailabilityInput,
  parseUpdateTrainingProjectDraftInput,
  parseUuid,
} from './training.validation';

@Controller('training/admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TrainingAdminController {
  constructor(
    private readonly projects: TrainingProjectService,
    private readonly attempts: TrainingAttemptService,
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

  @Patch('projects/:projectId')
  @RequirePermissions('training:projects:manage')
  async updateProject(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const parsedProjectId = parseUuid(projectId, 'projectId');

    return Object.prototype.hasOwnProperty.call(body, 'isOpen')
      ? this.projects.setAvailability(
          parsedProjectId,
          parseTrainingAvailabilityInput(body).isOpen,
        )
      : this.projects.updateDraft(
          parsedProjectId,
          parseUpdateTrainingProjectDraftInput(body),
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
}
