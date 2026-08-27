import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { AssistantController } from './assistant.controller';
import { AssistantAuditController } from './audit/assistant-audit.controller';
import { AssistantAuditService } from './audit/assistant-audit.service';
import { AssistantAnswerService } from './assistant-answer.service';
import { createAssistantPlannerGateway } from './assistant-planner-gateway';
import { AssistantQueryPlanner } from './assistant-query-planner';
import { AssistantRunProcessor } from './assistant-run.processor';
import { AssistantExternalConnectorsGuard, AssistantFeatureGuard } from './assistant-runtime-config';
import { AssistantSearchService } from './assistant-search.service';
import { AssistantService } from './assistant.service';
import { AssistantFeedbackController } from './feedback/assistant-feedback.controller';
import { AssistantFeedbackService } from './feedback/assistant-feedback.service';
import { AssistantSourcesModule } from './sources/assistant-sources.module';
import { AssistantGeoAliasService } from './geo/assistant-geo-alias.service';
import { AssistantGeoAliasesController, AssistantGeoController } from './geo/assistant-geo.controller';
import {
  AssistantGeoProviderPolicyService,
  createAssistantGeoProvider,
} from './geo/assistant-geo-provider-policy.service';
import { AssistantPlaceResolverService } from './geo/assistant-place-resolver.service';
import { AssistantModelUsagePolicyService } from './operations/assistant-model-usage-policy.service';
import { AssistantAiUsageBudgetService } from './operations/assistant-ai-usage-budget.service';
import { AssistantRetentionService } from './operations/assistant-retention.service';
import { AssistantUsageBudgetService } from './operations/assistant-usage-budget.service';
import { AssistantRolloutStageService } from './rollout/assistant-rollout-stage.service';

@Module({
  imports: [AuthModule, PrismaModule, AssistantSourcesModule],
  controllers: [
    AssistantController,
    AssistantFeedbackController,
    AssistantAuditController,
    AssistantGeoController,
    AssistantGeoAliasesController,
  ],
  providers: [
    AssistantService,
    AssistantFeedbackService,
    AssistantAuditService,
    AssistantRunProcessor,
    AssistantAnswerService,
    AssistantSearchService,
    AssistantPlaceResolverService,
    AssistantGeoAliasService,
    AssistantUsageBudgetService,
    AssistantAiUsageBudgetService,
    {
      provide: AssistantModelUsagePolicyService,
      inject: [AssistantUsageBudgetService, AssistantAiUsageBudgetService],
      useFactory: (
        budgets: AssistantUsageBudgetService,
        aiBudgets: AssistantAiUsageBudgetService,
      ) => new AssistantModelUsagePolicyService(budgets, process.env, aiBudgets),
    },
    AssistantRetentionService,
    AssistantRolloutStageService,
    {
      provide: AssistantGeoProviderPolicyService,
      inject: [PrismaService, AssistantUsageBudgetService],
      useFactory: (prisma: PrismaService, budgets: AssistantUsageBudgetService) => new AssistantGeoProviderPolicyService(
        prisma,
        createAssistantGeoProvider(),
        process.env,
        undefined,
        undefined,
        budgets,
      ),
    },
    {
      provide: AssistantQueryPlanner,
      inject: [AssistantModelUsagePolicyService],
      useFactory: (usage: AssistantModelUsagePolicyService) => new AssistantQueryPlanner(
        createAssistantPlannerGateway(),
        usage,
      ),
    },
    AssistantFeatureGuard,
    AssistantExternalConnectorsGuard,
  ],
})
export class AssistantModule {}
