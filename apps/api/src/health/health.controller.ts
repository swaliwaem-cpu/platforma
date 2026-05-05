import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const extensions = await this.prisma.$queryRaw<Array<{ extname: string }>>`
        SELECT extname
        FROM pg_extension
        WHERE extname = 'postgis'
      `;

      return {
        status: 'ok',
        database: 'ok',
        postgis: extensions.length > 0,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new ServiceUnavailableException({
        status: 'error',
        database: 'unavailable',
        message: error instanceof Error ? error.message : 'Unknown database error',
      });
    }
  }
}
