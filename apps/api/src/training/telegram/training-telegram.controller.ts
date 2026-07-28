import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/current-user.decorator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../auth/permissions.decorator';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TrainingTelegramLinkService } from './training-telegram-link.service';
import { TrainingTelegramWebhookService } from './training-telegram-webhook.service';
import { TrainingTelegramWorkerService } from './training-telegram-worker.service';

@Controller('training')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TrainingTelegramController {
  constructor(private readonly links: TrainingTelegramLinkService) {}

  @Get('telegram/account')
  @RequirePermissions('training:take')
  getAccount(@CurrentUser() user: AuthenticatedUser) {
    return this.links.getAccount(user.id);
  }

  @Post('telegram/link-tokens')
  @RequirePermissions('training:take')
  createLinkToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: Record<string, unknown>,
  ) {
    const projectId = readOptionalUuid(body.projectId, 'projectId');
    return this.links.issueLinkToken(user.id, projectId);
  }

  @Delete('telegram/account')
  @RequirePermissions('training:take')
  revokeAccount(@CurrentUser() user: AuthenticatedUser) {
    return this.links.revokeAccount(user.id);
  }

  @Post('projects/:projectId/start-link')
  @RequirePermissions('training:take')
  createProjectStartLink(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId') projectId: string,
  ) {
    return this.links.issueLinkToken(user.id, readUuid(projectId, 'projectId'));
  }
}

@Controller('training/telegram')
export class TrainingTelegramWebhookController {
  constructor(
    private readonly webhook: TrainingTelegramWebhookService,
    private readonly worker: TrainingTelegramWorkerService,
  ) {}

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async receiveWebhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() body: unknown,
  ) {
    this.webhook.verifySecret(secret);
    await this.webhook.acceptUpdate(body);
    this.worker.kick();
    return { ok: true };
  }
}

function readOptionalUuid(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return undefined;
  return readUuid(value, field);
}

function readUuid(value: unknown, field: string) {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  ) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}
