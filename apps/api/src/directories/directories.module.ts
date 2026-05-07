import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import {
  DevelopersController,
  LocationsController,
  MetroController,
} from './directories.controller';
import { DirectoriesService } from './directories.service';

@Module({
  imports: [PrismaModule],
  controllers: [DevelopersController, LocationsController, MetroController],
  providers: [DirectoriesService],
})
export class DirectoriesModule {}
