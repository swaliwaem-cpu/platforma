import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { WordpressImportController } from './wordpress-import.controller';
import { WordpressImportService } from './wordpress-import.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [WordpressImportController],
  providers: [WordpressImportService],
})
export class WordpressImportModule {}
