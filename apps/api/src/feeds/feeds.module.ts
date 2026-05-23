import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { PrismaModule } from '../prisma/prisma.module';
import { FeedsController } from './feeds.controller';
import { FeedsService } from './feeds.service';

@Module({
  imports: [AuthModule, FilesModule, PrismaModule],
  controllers: [FeedsController],
  providers: [FeedsService],
})
export class FeedsModule {}
