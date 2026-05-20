import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { PrismaModule } from '../prisma/prisma.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { MailService } from './mail.service';
import { MediaTokenGuard } from './media-token.guard';
import { PermissionsGuard } from './permissions.guard';

@Module({
  imports: [JwtModule.register({}), PrismaModule],
  controllers: [AuthController],
  providers: [AuthService, MailService, JwtAuthGuard, MediaTokenGuard, PermissionsGuard],
  exports: [JwtModule, JwtAuthGuard, MediaTokenGuard, PermissionsGuard],
})
export class AuthModule {}
