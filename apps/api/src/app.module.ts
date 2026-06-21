import { Module } from '@nestjs/common';

import { AuthModule } from './auth/auth.module';
import { CatalogLinksModule } from './catalog-links/catalog-links.module';
import { DirectoriesModule } from './directories/directories.module';
import { FeedsModule } from './feeds/feeds.module';
import { FilesModule } from './files/files.module';
import { HealthController } from './health/health.controller';
import { LotPresentationsModule } from './lot-presentations/lot-presentations.module';
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
    CatalogLinksModule,
    DirectoriesModule,
    FeedsModule,
    FilesModule,
    LotPresentationsModule,
    ObjectsModule,
    MapModule,
    WordpressImportModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
