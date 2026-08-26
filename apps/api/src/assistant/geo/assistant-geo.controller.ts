import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';

import { AuthenticatedUser } from '../../auth/auth.types';
import { CurrentUser } from '../../auth/current-user.decorator';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RequirePermissions } from '../../auth/permissions.decorator';
import { PermissionsGuard } from '../../auth/permissions.guard';
import { AssistantFeatureGuard } from '../assistant-runtime-config';
import { AssistantGeoAliasService } from './assistant-geo-alias.service';
import { AssistantPlaceResolverService } from './assistant-place-resolver.service';

@Controller('assistant/geo')
@UseGuards(JwtAuthGuard, PermissionsGuard, AssistantFeatureGuard)
@RequirePermissions('objects:read')
export class AssistantGeoController {
  constructor(private readonly resolver: AssistantPlaceResolverService) {}

  @Post('resolve')
  resolve(@Body() body: unknown, @CurrentUser() actor: AuthenticatedUser) {
    return this.resolver.resolve(body, actor.id);
  }
}

@Controller('assistant/geo/aliases')
@UseGuards(JwtAuthGuard, PermissionsGuard, AssistantFeatureGuard)
@RequirePermissions('assistant:sources:manage')
export class AssistantGeoAliasesController {
  constructor(private readonly aliases: AssistantGeoAliasService) {}

  @Get()
  list() {
    return this.aliases.list();
  }

  @Post()
  save(@CurrentUser() actor: AuthenticatedUser, @Body() body: unknown) {
    return this.aliases.save(actor.id, body);
  }

  @Delete(':aliasId')
  remove(@Param('aliasId') aliasId: string) {
    return this.aliases.remove(aliasId);
  }
}
