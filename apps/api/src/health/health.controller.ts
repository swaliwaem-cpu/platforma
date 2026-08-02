import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { isTrainingModuleEnabled } from '../training/training-runtime-config';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        status: 'ok',
        database: 'ok',
        training: isTrainingModuleEnabled() ? 'ready' : 'disabled',
      };
    } catch {
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'unavailable',
        training: isTrainingModuleEnabled() ? 'degraded' : 'disabled',
      });
    }
  }
}
