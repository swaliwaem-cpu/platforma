import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { TrainingConfigService } from './training.config';
import { TrainingController } from './training.controller';

@Module({
  imports: [AuthModule],
  controllers: [TrainingController],
  providers: [TrainingConfigService],
})
export class TrainingModule {}
