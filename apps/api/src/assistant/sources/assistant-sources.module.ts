import { Module } from '@nestjs/common';

import { AuthModule } from '../../auth/auth.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { AssistantAiUsageBudgetService } from '../operations/assistant-ai-usage-budget.service';
import { AssistantEmbeddingGateway } from './assistant-embedding.gateway';
import { AssistantKnowledgeRetrievalService } from './assistant-knowledge-retrieval.service';
import { AssistantSourceConnectorRegistry } from './assistant-source-connector.registry';
import { AssistantSourceIngestionService } from './assistant-source-ingestion.service';
import { AssistantSourceRegistryService } from './assistant-source-registry.service';
import { AssistantSourceWorker } from './assistant-source.worker';
import { AssistantSourcesController } from './assistant-sources.controller';
import { OfficialSourceExtractor } from './official-source.extractor';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [AssistantSourcesController],
  providers: [
    AssistantSourceRegistryService,
    AssistantSourceIngestionService,
    AssistantKnowledgeRetrievalService,
    AssistantSourceWorker,
    OfficialSourceExtractor,
    AssistantAiUsageBudgetService,
    {
      provide: AssistantSourceConnectorRegistry,
      useFactory: () => new AssistantSourceConnectorRegistry(),
    },
    {
      provide: AssistantEmbeddingGateway,
      inject: [AssistantAiUsageBudgetService],
      useFactory: (budgets: AssistantAiUsageBudgetService) => new AssistantEmbeddingGateway(
        process.env,
        fetch,
        budgets,
      ),
    },
  ],
  exports: [AssistantKnowledgeRetrievalService, AssistantSourceRegistryService],
})
export class AssistantSourcesModule {}
