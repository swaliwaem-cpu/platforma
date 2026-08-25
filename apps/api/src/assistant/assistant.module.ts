import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { AssistantController } from './assistant.controller';
import { AssistantAnswerService } from './assistant-answer.service';
import { createAssistantPlannerGateway } from './assistant-planner-gateway';
import { AssistantQueryPlanner } from './assistant-query-planner';
import { AssistantRunProcessor } from './assistant-run.processor';
import { AssistantFeatureGuard } from './assistant-runtime-config';
import { AssistantSearchService } from './assistant-search.service';
import { AssistantService } from './assistant.service';
import { AssistantSourcesModule } from './sources/assistant-sources.module';
import { AssistantGeoAliasService } from './geo/assistant-geo-alias.service';
import { AssistantGeoAliasesController, AssistantGeoController } from './geo/assistant-geo.controller';
import {
  AssistantGeoProviderPolicyService,
  createAssistantGeoProvider,
} from './geo/assistant-geo-provider-policy.service';
import { AssistantPlaceResolverService } from './geo/assistant-place-resolver.service';

@Module({
  imports: [AuthModule, PrismaModule, AssistantSourcesModule],
  controllers: [AssistantController, AssistantGeoController, AssistantGeoAliasesController],
  providers: [
    AssistantService,
    AssistantRunProcessor,
    AssistantAnswerService,
    AssistantSearchService,
    AssistantPlaceResolverService,
    AssistantGeoAliasService,
    {
      provide: AssistantGeoProviderPolicyService,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => new AssistantGeoProviderPolicyService(
        prisma,
        createAssistantGeoProvider(),
      ),
    },
    {
      provide: AssistantQueryPlanner,
      useFactory: () => new AssistantQueryPlanner(createAssistantPlannerGateway()),
    },
    AssistantFeatureGuard,
  ],
})
export class AssistantModule {}
