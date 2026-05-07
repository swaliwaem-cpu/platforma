import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { S3StorageService } from './s3-storage.service';

@Module({
  imports: [PrismaModule],
  controllers: [FilesController],
  providers: [FilesService, S3StorageService],
  exports: [FilesService],
})
export class FilesModule {}
