import { Controller, Get, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { MapService } from './map.service';

@Controller('map')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MapController {
  constructor(private readonly mapService: MapService) {}

  @Get('objects')
  @RequirePermissions('objects:read')
  async listObjects(@Query() query: Record<string, string | undefined>) {
    return this.mapService.listObjects(query);
  }
}
