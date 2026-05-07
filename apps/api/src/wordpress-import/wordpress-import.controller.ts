import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RequirePermissions } from '../auth/permissions.decorator';
import { PermissionsGuard } from '../auth/permissions.guard';
import { WordpressImportService } from './wordpress-import.service';

@Controller('wordpress-import')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class WordpressImportController {
  constructor(private readonly wordpressImportService: WordpressImportService) {}

  @Post('preview')
  @RequirePermissions('import:preview')
  async runPreview() {
    return this.wordpressImportService.runImportCommand('preview');
  }

  @Post('run')
  @RequirePermissions('import:run')
  async runImport() {
    return this.wordpressImportService.runImportCommand('run');
  }

  @Get('reports')
  @RequirePermissions('import:preview')
  async listReports(@Query() query: Record<string, string | undefined>) {
    return this.wordpressImportService.listReports(query);
  }

  @Get('reports/:id')
  @RequirePermissions('import:preview')
  async getReport(@Param('id') id: string) {
    return this.wordpressImportService.getReport(id);
  }
}
