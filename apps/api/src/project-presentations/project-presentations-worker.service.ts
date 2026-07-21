import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ProjectPresentationDocumentStatus } from '@prisma/client';

import { AuthenticatedUser } from '../auth/auth.types';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectPresentationsPdfService } from './project-presentations-pdf.service';
import { isProjectPresentationSnapshot } from './project-presentations.types';

const pollIntervalMs = 2_000;
const staleJobMs = 15 * 60_000;
const maxAttempts = 3;

@Injectable()
export class ProjectPresentationsWorkerService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly filesService: FilesService,
    private readonly pdfService: ProjectPresentationsPdfService,
  ) {}

  async onModuleInit() {
    const staleBefore = new Date(Date.now() - staleJobMs);
    await this.prisma.projectPresentationDocument.updateMany({
      where: {
        status: ProjectPresentationDocumentStatus.RUNNING,
        OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }],
        attempts: { lt: maxAttempts },
      },
      data: { status: ProjectPresentationDocumentStatus.PENDING, startedAt: null, heartbeatAt: null, errorMessage: 'Generation was interrupted and queued again' },
    });
    await this.prisma.projectPresentationDocument.updateMany({
      where: {
        status: ProjectPresentationDocumentStatus.RUNNING,
        OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }],
        attempts: { gte: maxAttempts },
      },
      data: { status: ProjectPresentationDocumentStatus.FAILED, finishedAt: new Date(), errorMessage: 'Generation stopped after the maximum number of attempts' },
    });
    this.timer = setInterval(() => void this.drain(), pollIntervalMs);
    this.kick();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  kick() {
    void this.drain();
  }

  private async drain() {
    if (this.active) return;
    this.active = true;
    let processed = false;
    try {
      const candidate = await this.prisma.projectPresentationDocument.findFirst({
        where: { status: ProjectPresentationDocumentStatus.PENDING, attempts: { lt: maxAttempts } },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (!candidate) return;
      const startedAt = new Date();
      const claimed = await this.prisma.projectPresentationDocument.updateMany({
        where: { id: candidate.id, status: ProjectPresentationDocumentStatus.PENDING },
        data: {
          status: ProjectPresentationDocumentStatus.RUNNING,
          attempts: { increment: 1 },
          progress: 1,
          startedAt,
          heartbeatAt: startedAt,
          finishedAt: null,
          errorMessage: null,
        },
      });
      if (claimed.count !== 1) return;
      processed = true;
      await this.process(candidate.id);
    } finally {
      this.active = false;
      if (processed) queueMicrotask(() => void this.drain());
    }
  }

  private async process(documentId: string) {
    let uploadedFileId: string | null = null;
    try {
      const document = await this.prisma.projectPresentationDocument.findUnique({
        where: { id: documentId },
        include: {
          owner: {
            include: {
              role: true,
              profilePhotoFile: true,
            },
          },
        },
      });
      if (!document || document.status !== ProjectPresentationDocumentStatus.RUNNING) return;
      if (!isProjectPresentationSnapshot(document.snapshotJson)) throw new Error('Project presentation snapshot is invalid');
      const buffer = await this.pdfService.generate(document.snapshotJson, async (progress) => {
        await this.prisma.projectPresentationDocument.updateMany({
          where: { id: documentId, status: ProjectPresentationDocumentStatus.RUNNING },
          data: { progress: Math.max(1, Math.min(progress, 99)), heartbeatAt: new Date() },
        });
      });
      const actor: AuthenticatedUser = {
        id: document.owner.id,
        email: document.owner.email,
        name: document.owner.name,
        brokerPhone: document.owner.brokerPhone,
        brokerEmail: document.owner.brokerEmail,
        status: document.owner.status,
        role: { id: document.owner.role.id, name: document.owner.role.name },
        profilePhotoFile: document.owner.profilePhotoFile
          ? {
              id: document.owner.profilePhotoFile.id,
              url: document.owner.profilePhotoFile.url,
              originalName: document.owner.profilePhotoFile.originalName,
              mimeType: document.owner.profilePhotoFile.mimeType,
              updatedAt: document.owner.profilePhotoFile.updatedAt.toISOString(),
            }
          : null,
        permissions: [],
      };
      const uploaded = await this.filesService.uploadFile(
        {
          fieldname: 'file',
          buffer,
          encoding: '7bit',
          mimetype: 'application/pdf',
          originalname: `${this.slugify(document.title)}.pdf`,
          size: buffer.length,
        },
        actor,
        'pdf',
      );
      uploadedFileId = uploaded.file.id;
      const completed = await this.prisma.projectPresentationDocument.updateMany({
        where: { id: documentId, status: ProjectPresentationDocumentStatus.RUNNING },
        data: {
          fileId: uploadedFileId,
          status: ProjectPresentationDocumentStatus.READY,
          progress: 100,
          heartbeatAt: new Date(),
          finishedAt: new Date(),
          errorMessage: null,
        },
      });
      if (completed.count !== 1) await this.filesService.deleteUnlinkedFile(uploadedFileId);
    } catch (error) {
      if (uploadedFileId) await this.filesService.deleteUnlinkedFile(uploadedFileId);
      const message = error instanceof Error ? error.message : 'Unknown generation error';
      await this.prisma.projectPresentationDocument.updateMany({
        where: { id: documentId, status: ProjectPresentationDocumentStatus.RUNNING },
        data: {
          status: ProjectPresentationDocumentStatus.FAILED,
          progress: 0,
          heartbeatAt: new Date(),
          finishedAt: new Date(),
          errorMessage: message.slice(0, 1000),
        },
      });
    }
  }

  private slugify(value: string) {
    return value.trim().toLowerCase().replace(/[^a-z0-9а-яё]+/giu, '-').replace(/^-+|-+$/gu, '').slice(0, 80) || 'project-presentation';
  }
}
