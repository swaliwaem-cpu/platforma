import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { TrainingAdminController } from './training-admin.controller';
import { TrainingConfigService } from './training.config';
import { TrainingContentService } from './training-content.service';
import { TrainingController } from './training.controller';
import { TrainingDocumentWorkerService } from './training-document-worker.service';
import { TrainingDocumentsService } from './training-documents.service';

@Module({
  imports: [AuthModule, FilesModule],
  controllers: [TrainingController, TrainingAdminController],
  providers: [
    TrainingConfigService,
    TrainingContentService,
    TrainingDocumentsService,
    TrainingDocumentWorkerService,
  ],
})
export class TrainingModule {}
