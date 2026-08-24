import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AssistantController } from './assistant.controller';
import { AssistantRunProcessor } from './assistant-run.processor';
import { AssistantFeatureGuard } from './assistant-runtime-config';
import { AssistantService } from './assistant.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [AssistantController],
  providers: [AssistantService, AssistantRunProcessor, AssistantFeatureGuard],
})
export class AssistantModule {}
