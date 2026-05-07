import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { FilesModule } from '../files/files.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ObjectsController } from './objects.controller';
import { ObjectsService } from './objects.service';

@Module({
  imports: [AuthModule, PrismaModule, FilesModule],
  controllers: [ObjectsController],
  providers: [ObjectsService],
})
export class ObjectsModule {}
