import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { CatalogLinksService } from './catalog-links.service';

@Controller('catalog-links')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class CatalogLinksController {
  constructor(private readonly catalogLinksService: CatalogLinksService) {}

  @Get()
  @RequirePermissions('objects:read')
  async list() {
    return this.catalogLinksService.listPublic();
  }

  @Get('admin')
  @RequirePermissions('admin:access', 'objects:update')
  async listAdmin() {
    return this.catalogLinksService.listAdmin();
  }

  @Put('admin')
  @RequirePermissions('admin:access', 'objects:update')
  async updateAdmin(@Body() body: Record<string, unknown>) {
    return this.catalogLinksService.updateAdmin(body);
  }
}
