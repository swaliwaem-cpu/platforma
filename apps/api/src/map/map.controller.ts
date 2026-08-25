import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import type { MapWalkingRoutesRequest } from '@platforma/shared' with { 'resolution-mode': 'import' };

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { MapRoutingService } from './map-routing.service';
import { MapService } from './map.service';

@Controller('map')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class MapController {
  constructor(
    private readonly mapService: MapService,
    private readonly mapRoutingService: MapRoutingService,
  ) {}

  @Get('objects')
  @RequirePermissions('objects:read')
  async listObjects(@Query() query: Record<string, string | undefined>) {
    return this.mapService.listObjects(query);
  }

  @Post('walking-routes')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('objects:read')
  async getWalkingRoutes(@Body() body: MapWalkingRoutesRequest) {
    return this.mapRoutingService.getWalkingRoutes(body);
  }

  @Post('walking-routes/refresh')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('objects:read', 'admin:access')
  async refreshWalkingRoutes(@Body() body: MapWalkingRoutesRequest) {
    return this.mapRoutingService.refreshWalkingRoutes(body);
  }
}
