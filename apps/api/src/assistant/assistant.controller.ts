import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { AssistantFeatureGuard, isAssistantEnabledForActor } from './assistant-runtime-config';
import { AssistantService } from './assistant.service';

@Controller('assistant')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('objects:read')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get('config')
  getConfig(@CurrentUser() actor: AuthenticatedUser) {
    return { enabled: isAssistantEnabledForActor(actor) };
  }

  @Get('eval/runtime')
  @UseGuards(AssistantFeatureGuard)
  @RequirePermissions('objects:read', 'assistant:audit:read')
  getEvalRuntime() {
    return this.assistant.getEvalRuntimeContract();
  }

  @Get('conversations')
  @UseGuards(AssistantFeatureGuard)
  listConversations(
    @CurrentUser() actor: AuthenticatedUser,
    @Query('cursor') cursor?: string,
  ) {
    return this.assistant.listConversations(actor.id, cursor);
  }

  @Post('conversations')
  @UseGuards(AssistantFeatureGuard)
  createConversation(
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.assistant.createConversation(actor.id, idempotencyKey);
  }

  @Get('conversations/:conversationId')
  @UseGuards(AssistantFeatureGuard)
  getConversation(
    @Param('conversationId') conversationId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.assistant.getConversation(conversationId, actor.id);
  }

  @Post('conversations/:conversationId/messages')
  @UseGuards(AssistantFeatureGuard)
  @HttpCode(HttpStatus.ACCEPTED)
  sendMessage(
    @Param('conversationId') conversationId: string,
    @Headers('Idempotency-Key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.assistant.startRun({
      conversationId,
      ownerUserId: actor.id,
      idempotencyKey,
      body,
    });
  }

  @Get('runs/:runId')
  @UseGuards(AssistantFeatureGuard)
  getRun(
    @Param('runId') runId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.assistant.getRun(runId, actor.id);
  }
}
