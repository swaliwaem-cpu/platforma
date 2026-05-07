import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { MapController } from './map.controller';
import { MapService } from './map.service';

@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [MapController],
  providers: [MapService],
})
export class MapModule {}
