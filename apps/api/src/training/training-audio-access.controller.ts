import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';

import { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import type { FileContentResponse } from '../files/file-content-response';
import { TrainingAudioAccessService } from './training-audio-access.service';
import { TrainingFeatureGuard } from './training-runtime-config';
import { parseUuid } from './training.validation';

@Controller('training/admin')
@UseGuards(TrainingFeatureGuard, JwtAuthGuard, PermissionsGuard)
export class TrainingAudioAccessController {
  constructor(private readonly audio: TrainingAudioAccessService) {}

  @Get('answers/:answerId/audio')
  @RequirePermissions('training:audio:read')
  async getAnswerAudio(
    @Param('answerId') answerId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Res() response: FileContentResponse,
  ) {
    const audio = await this.audio.readAnswerAudio(parseUuid(answerId, 'answerId'), actor.id);

    response.setHeader('Content-Type', audio.mimeType);
    response.setHeader('Content-Length', audio.buffer.length);
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('Pragma', 'no-cache');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Disposition', 'inline; filename="training-answer-audio.wav"');
    response.send(audio.buffer);
  }
}
