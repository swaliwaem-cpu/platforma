import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { MediaController } from './media.controller';
import { S3StorageService } from './s3-storage.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [FilesController, MediaController],
  providers: [FilesService, S3StorageService],
  exports: [FilesService],
})
export class FilesModule {}
