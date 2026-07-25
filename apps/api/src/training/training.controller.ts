import { Controller, Get, UseGuards } from '@nestjs/common';
import type { TrainingModuleConfigResponse } from '@platforma/shared' with { 'resolution-mode': 'import' };

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { TrainingConfigService } from './training.config';

@Controller('training')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class TrainingController {
  constructor(private readonly trainingConfig: TrainingConfigService) {}

  @Get('config')
  @RequirePermissions('training:projects:read')
  getConfig(): TrainingModuleConfigResponse {
    return this.trainingConfig.getConfig();
  }
}
