import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';

import { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/current-user.decorator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../auth/permissions.decorator';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { AssistantFeatureGuard } from '../assistant-runtime-config';
import { AssistantFeedbackService } from './assistant-feedback.service';

@Controller('assistant/messages')
@UseGuards(JwtAuthGuard, PermissionsGuard, AssistantFeatureGuard)
@RequirePermissions('objects:read')
export class AssistantFeedbackController {
  constructor(private readonly feedback: AssistantFeedbackService) {}

  @Post(':messageId/feedback')
  save(
    @Param('messageId') messageId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() body: unknown,
  ) {
    return this.feedback.save(messageId, actor.id, body);
  }
}
