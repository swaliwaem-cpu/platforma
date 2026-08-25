import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { AssistantController } from './assistant.controller';
import { AssistantAnswerService } from './assistant-answer.service';
import { createAssistantPlannerGateway } from './assistant-planner-gateway';
import { AssistantQueryPlanner } from './assistant-query-planner';
import { AssistantRunProcessor } from './assistant-run.processor';
import { AssistantFeatureGuard } from './assistant-runtime-config';
import { AssistantSearchService } from './assistant-search.service';
import { AssistantService } from './assistant.service';
import { AssistantSourcesModule } from './sources/assistant-sources.module';

@Module({
  imports: [AuthModule, PrismaModule, AssistantSourcesModule],
  controllers: [AssistantController],
  providers: [
    AssistantService,
    AssistantRunProcessor,
    AssistantAnswerService,
    AssistantSearchService,
    {
      provide: AssistantQueryPlanner,
      useFactory: () => new AssistantQueryPlanner(createAssistantPlannerGateway()),
    },
    AssistantFeatureGuard,
  ],
})
export class AssistantModule {}
