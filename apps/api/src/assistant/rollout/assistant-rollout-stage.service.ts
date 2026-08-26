import { Injectable, OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service';
import { getAssistantRuntimeConfig } from '../assistant-runtime-config';
import {
  assessAssistantPilotCohortAgainstApproval,
  assessAssistantRolloutStageRecord,
} from './assistant-rollout-preflight';

@Injectable()
export class AssistantRolloutStageService implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    const runtime = getAssistantRuntimeConfig();
    const stage = runtime.rolloutStage;
    const events = await this.prisma.assistantRolloutEvent.findMany({
      select: { stage: true, gateDigest: true, approvalJson: true, startedAt: true },
    });
    const assessment = assessAssistantRolloutStageRecord(stage, events);
    if (!assessment.passed) throw new Error(assessment.blocker ?? 'ASSISTANT_ROLLOUT_STAGE_EVENT_INVALID');
    if (!assessment.current) throw new Error('ASSISTANT_ROLLOUT_STAGE_EVENT_REQUIRED');
    if (stage === 'ADMINS') return;
    const users = await this.prisma.user.findMany({
      where: { id: { in: runtime.pilotUserIds } },
      select: {
        id: true,
        status: true,
        deletedAt: true,
        role: {
          select: {
            permissions: { select: { permission: { select: { key: true } } } },
          },
        },
      },
    });
    const cohort = assessAssistantPilotCohortAgainstApproval(
      runtime.pilotUserIds,
      users.map((user) => ({
        id: user.id,
        status: user.status,
        deletedAt: user.deletedAt,
        permissions: user.role.permissions.map(({ permission }) => permission.key),
      })),
      assessment.current.approvalJson,
    );
    if (!cohort.passed) throw new Error('ASSISTANT_ROLLOUT_PILOT_COHORT_DRIFT');
  }
}
