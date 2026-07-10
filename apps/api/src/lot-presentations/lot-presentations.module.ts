import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LotPresentationsAccessGuard } from './lot-presentations-access.guard';
import { LotPresentationsController } from './lot-presentations.controller';
import { LotPresentationsPdfService } from './lot-presentations-pdf.service';
import { LotPresentationsService } from './lot-presentations.service';

@Module({
  imports: [AuthModule, PrismaModule, FilesModule],
  controllers: [LotPresentationsController],
  providers: [LotPresentationsService, LotPresentationsPdfService, LotPresentationsAccessGuard],
})
export class LotPresentationsModule {}
