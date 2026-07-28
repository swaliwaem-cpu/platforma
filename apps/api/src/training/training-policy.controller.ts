import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { TrainingPolicyAcceptanceSource } from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TrainingFeatureGuard } from './training-feature.guard';
import { TrainingPolicyService } from './training-policy.service';

@Controller('training/policy')
@UseGuards(JwtAuthGuard, PermissionsGuard, TrainingFeatureGuard)
export class TrainingPolicyController {
  constructor(private readonly policy: TrainingPolicyService) {}

  @Get()
  @RequirePermissions('training:take')
  getCurrent(@CurrentUser() user: AuthenticatedUser) {
    return this.policy.getCurrentPolicy(user.id);
  }

  @Post('accept')
  @RequirePermissions('training:take')
  accept(@CurrentUser() user: AuthenticatedUser) {
    return this.policy.accept(
      user.id,
      TrainingPolicyAcceptanceSource.PLATFORM,
    );
  }
}
