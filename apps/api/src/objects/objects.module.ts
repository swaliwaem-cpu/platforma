import { Module } from '@nestjs/common';

import { FilesModule } from '../files/files.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ObjectsController } from './objects.controller';
import { ObjectsService } from './objects.service';

@Module({
  imports: [PrismaModule, FilesModule],
  controllers: [ObjectsController],
  providers: [ObjectsService],
})
export class ObjectsModule {}
