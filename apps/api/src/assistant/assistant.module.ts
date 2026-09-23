import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AssistantCatalogTools } from './assistant-catalog.tools';
import { AssistantController, AssistantFeatureGuard } from './assistant.controller';
import { AssistantLlmClient } from './assistant-llm.client';
import { AssistantService } from './assistant.service';
import { AssistantWebTools } from './assistant-web.tools';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [AssistantController],
  providers: [AssistantService, AssistantFeatureGuard, AssistantLlmClient, AssistantCatalogTools, AssistantWebTools],
})
export class AssistantModule {}
