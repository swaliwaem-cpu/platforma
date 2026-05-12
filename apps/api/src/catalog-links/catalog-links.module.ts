import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CatalogLinksController } from './catalog-links.controller';
import { CatalogLinksService } from './catalog-links.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [CatalogLinksController],
  providers: [CatalogLinksService],
})
export class CatalogLinksModule {}
