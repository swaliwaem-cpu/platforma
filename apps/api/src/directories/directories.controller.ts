import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { DirectoriesService } from './directories.service';

@Controller('developers')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class DevelopersController {
  constructor(private readonly directoriesService: DirectoriesService) {}

  @Get()
  @RequirePermissions('developers:read')
  async list(@Query() query: Record<string, string | undefined>) {
    return this.directoriesService.listDevelopers(query);
  }
}

@Controller('locations')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class LocationsController {
  constructor(private readonly directoriesService: DirectoriesService) {}

  @Get()
  @RequirePermissions('locations:read')
  async list(@Query() query: Record<string, string | undefined>) {
    return this.directoriesService.listLocations(query);
  }
}

@Controller('metro')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MetroController {
  constructor(private readonly directoriesService: DirectoriesService) {}

  @Get()
  @RequirePermissions('metro:read')
  async list(@Query() query: Record<string, string | undefined>) {
    return this.directoriesService.listMetroStations(query);
  }
}
