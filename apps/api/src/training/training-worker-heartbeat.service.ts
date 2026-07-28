import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TrainingWorkerHeartbeatService {
  constructor(private readonly prisma: PrismaService) {}

  register(workerKind: string, instanceId: string) {
    const now = new Date();
    return this.prisma.trainingWorkerHeartbeat.upsert({
      where: { instanceId },
      update: { lastSeenAt: now },
      create: {
        workerKind,
        instanceId,
        startedAt: now,
        lastSeenAt: now,
      },
    });
  }

  touch(instanceId: string) {
    return this.prisma.trainingWorkerHeartbeat.updateMany({
      where: { instanceId },
      data: { lastSeenAt: new Date() },
    });
  }
}
