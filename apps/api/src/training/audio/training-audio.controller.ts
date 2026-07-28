import {
  Controller,
  Get,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/current-user.decorator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../auth/permissions.decorator';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { TrainingFeatureGuard } from '../training-feature.guard';
import {
  TrainingAudioAccessService,
  type TrainingAudioAuditRequest,
} from './training-audio-access.service';

type TrainingAudioResponse = {
  setHeader(name: string, value: string | number): void;
  send(body: Buffer): void;
};

@Controller('training/admin/answers')
@UseGuards(JwtAuthGuard, PermissionsGuard, TrainingFeatureGuard)
export class TrainingAudioController {
  constructor(private readonly audio: TrainingAudioAccessService) {}

  @Get(':answerId/audio')
  @RequirePermissions('training:audio:read')
  async getAnswerAudio(
    @Param('answerId') answerId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: TrainingAudioAuditRequest,
    @Res() response: TrainingAudioResponse,
  ) {
    const content = await this.audio.getAnswerAudio(
      answerId,
      actor,
      request,
    );
    response.setHeader('Content-Type', content.mimeType);
    response.setHeader('Content-Length', content.sizeBytes);
    response.setHeader(
      'Content-Disposition',
      'inline; filename="training-answer-audio.wav"',
    );
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.send(content.buffer);
  }
}
