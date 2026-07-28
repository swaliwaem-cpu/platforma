import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TrainingAttemptEngineService } from './training-attempt-engine.service';
import { parseTrainingReviewIdempotencyKey } from './training-review-idempotency';

@Controller('training/admin')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('training:results:review')
export class TrainingReviewController {
  constructor(private readonly attempts: TrainingAttemptEngineService) {}

  @Post('results/:attemptId/review')
  review(
    @Param('attemptId') attemptId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() reviewer: AuthenticatedUser,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    const decision = parseReviewDecision(body.decision);
    const adminScore =
      typeof body.adminScore === 'number' || typeof body.adminScore === 'string'
        ? body.adminScore
        : undefined;
    return this.attempts.reviewAttempt({
      attemptId,
      reviewerId: reviewer.id,
      idempotencyKey: parseTrainingReviewIdempotencyKey(
        idempotencyKey,
      ),
      decision,
      adminScore,
      comment: typeof body.comment === 'string' ? body.comment : '',
      unsupportedClaimsDecisions: body.unsupportedClaimsDecisions,
    });
  }

  @Post('answers/:answerId/reprocess-transcription')
  @HttpCode(HttpStatus.ACCEPTED)
  reprocessTranscription(
    @Param('answerId') answerId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() reviewer: AuthenticatedUser,
  ) {
    return this.attempts.reprocessTranscription({
      answerId,
      reviewerId: reviewer.id,
      comment: typeof body.comment === 'string' ? body.comment : '',
    });
  }

  @Post('answers/:answerId/reprocess-evaluation')
  @HttpCode(HttpStatus.ACCEPTED)
  reprocessEvaluation(
    @Param('answerId') answerId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() reviewer: AuthenticatedUser,
  ) {
    return this.attempts.reprocessEvaluation({
      answerId,
      reviewerId: reviewer.id,
      comment: typeof body.comment === 'string' ? body.comment : '',
    });
  }
}

function parseReviewDecision(value: unknown) {
  if (value === 'APPROVED' || value === 'OVERRIDDEN') return value;
  throw new BadRequestException(
    'Training review decision must be APPROVED or OVERRIDDEN',
  );
}
