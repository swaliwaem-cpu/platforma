import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/current-user.decorator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../auth/permissions.decorator';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { AssistantSourceRegistryService } from './assistant-source-registry.service';

@Controller('assistant/sources')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('assistant:sources:manage')
export class AssistantSourcesController {
  constructor(private readonly sources: AssistantSourceRegistryService) {}

  @Get()
  list() {
    return this.sources.list();
  }

  @Post()
  register(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: unknown,
  ) {
    return this.sources.register(actor.id, body);
  }

  @Patch(':sourceId')
  update(
    @Param('sourceId') sourceId: string,
    @Body() body: unknown,
  ) {
    return this.sources.update(sourceId, body);
  }

  @Post(':sourceId/refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  refresh(
    @Param('sourceId') sourceId: string,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.sources.queueManualRefresh(sourceId, actor.id, idempotencyKey);
  }

  @Post('projects/:projectKey/refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  refreshProject(
    @Param('projectKey') projectKey: string,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.sources.queueProjectRefresh(projectKey, actor.id, idempotencyKey);
  }
}
