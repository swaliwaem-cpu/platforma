import { Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module';
import { DirectoriesModule } from './directories/directories.module';
import { FilesModule } from './files/files.module';
import { HealthController } from './health/health.controller';
import { MapModule } from './map/map.module';
import { ObjectsModule } from './objects/objects.module';
import { PrismaModule } from './prisma/prisma.module';
import { UsersModule } from './users/users.module';
import { WordpressImportModule } from './wordpress-import/wordpress-import.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,
    UsersModule,
    DirectoriesModule,
    FilesModule,
    ObjectsModule,
    MapModule,
    WordpressImportModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
