import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AssistantCatalogTools } from './assistant-catalog.tools';
import { AssistantAdminController, AssistantController, AssistantFeatureGuard } from './assistant.controller';
import { AssistantLlmClient } from './assistant-llm.client';
import { AssistantTurnLogService } from './assistant-turn-log.service';
import { AssistantService } from './assistant.service';
import { AssistantWebTools } from './assistant-web.tools';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [AssistantController, AssistantAdminController],
  providers: [
    AssistantService,
    AssistantFeatureGuard,
    AssistantLlmClient,
    AssistantCatalogTools,
    AssistantWebTools,
    AssistantTurnLogService,
  ],
})
export class AssistantModule {}
