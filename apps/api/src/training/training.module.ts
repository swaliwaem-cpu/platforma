import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { TrainingAdminController } from './training-admin.controller';
import { TrainingConfigService } from './training.config';
import { TrainingContentService } from './training-content.service';
import { TrainingController } from './training.controller';

@Module({
  imports: [AuthModule],
  controllers: [TrainingController, TrainingAdminController],
  providers: [TrainingConfigService, TrainingContentService],
})
export class TrainingModule {}
