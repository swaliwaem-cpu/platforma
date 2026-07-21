import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { ProjectPresentationsAdminGuard } from './project-presentations-admin.guard';
import { ProjectPresentationsController } from './project-presentations.controller';
import { ProjectPresentationsPdfService } from './project-presentations-pdf.service';
import { ProjectPresentationsService } from './project-presentations.service';
import { ProjectPresentationsWorkerService } from './project-presentations-worker.service';

@Module({
  imports: [AuthModule, FilesModule],
  controllers: [ProjectPresentationsController],
  providers: [
    ProjectPresentationsAdminGuard,
    ProjectPresentationsService,
    ProjectPresentationsPdfService,
    ProjectPresentationsWorkerService,
  ],
})
export class ProjectPresentationsModule {}
