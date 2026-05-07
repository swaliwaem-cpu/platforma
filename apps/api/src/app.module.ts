import { Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module';
import { FilesModule } from './files/files.module';
import { HealthController } from './health/health.controller';
import { ObjectsModule } from './objects/objects.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [PrismaModule, AuthModule, UsersModule, FilesModule, ObjectsModule],
  controllers: [HealthController],
})
export class AppModule {}
