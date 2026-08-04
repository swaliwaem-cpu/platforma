import { Controller, Get } from '@nestjs/common';

import { isTrainingModuleEnabled } from './training-runtime-config';

@Controller('training')
export class TrainingConfigController {
  @Get('config')
  getConfig() {
    return { enabled: isTrainingModuleEnabled() };
  }
}
