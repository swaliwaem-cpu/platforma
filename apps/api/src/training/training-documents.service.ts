import { basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingSourceDocumentType,
  TrainingSourceExtractionStatus,
  TrainingVersionStatus,
} from '@prisma/client';

import type { AuthenticatedUser } from '../auth/auth.types';
import { FilesService } from '../files/files.service';
import type { UploadedFile } from '../files/uploaded-file.type';
import { PrismaService } from '../prisma/prisma.service';
import type { TrainingAuditRequest } from './training-content.service';
import {
  TRAINING_DOCUMENT_EXTENSIONS,
  TRAINING_DOCUMENT_MIME_TYPES,
  TRAINING_MAX_DOCUMENT_BYTES,
  TRAINING_MAX_EXTRACTED_CHARACTERS,
} from './training-document.config';

const documentFileSelect = {
  id: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  createdAt: true,
} satisfies Prisma.FileSelect;

const documentInclude = {
  file: {
    select: documentFileSelect,
  },
  _count: {
    select: {
      facts: true,
    },
  },
} satisfies Prisma.TrainingSourceDocumentInclude;

type TrainingDocumentRecord = Prisma.TrainingSourceDocumentGetPayload<{
  include: typeof documentInclude;
}>;

@Injectable()
export class TrainingDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  async listRealEstateObjects(query: Record<string, string | undefined>) {
    const search = query.search?.trim().slice(0, 200) ?? '';
    const requestedLimit = Number(query.limit ?? 30);
    const limit =
      Number.isInteger(requestedLimit) && requestedLimit > 0
        ? Math.min(requestedLimit, 100)
        : 30;
    const items = await this.prisma.realEstateObject.findMany({
      where: search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' } },
              { slug: { contains: search, mode: 'insensitive' } },
            ],
          }
        : undefined,
      orderBy: [{ title: 'asc' }],
      take: limit,
      select: {
        id: true,
        title: true,
        slug: true,
        status: true,
      },
    });

    return { items };
  }

  async listDocuments(versionIdInput: string) {
    const versionId = await this.requireVersion(versionIdInput);
    const items = await this.prisma.trainingSourceDocument.findMany({
      where: { projectVersionId: versionId.id },
      orderBy: { createdAt: 'asc' },
      include: documentInclude,
    });

    return { items: items.map((item) => this.serializeDocument(item)) };
  }

  async getDocumentText(versionIdInput: string, documentIdInput: string) {
    const document = await this.findDocument(versionIdInput, documentIdInput);

    return {
      document: this.serializeDocument(document),
      extractedText: document.extractedText ?? '',
      extractionMetadata: document.extractionMetadataJson,
      draftOnly: true,
      scoringEligible: false,
    };
  }

  async uploadDocument(
    versionIdInput: string,
    fileInput: UploadedFile | undefined,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const version = await this.requireDraftVersion(versionIdInput);
    const file = this.validateUpload(fileInput);
    const documentType = this.resolveDocumentType(file);
    const extension = TRAINING_DOCUMENT_EXTENSIONS[documentType];
    const storedFile = await this.files.uploadPrivateTrainingDocument(
      file,
      actor,
      extension,
    );
    let documentId: string | null = null;

    try {
      documentId = await this.prisma.$transaction(async (tx) => {
        const document = await tx.trainingSourceDocument.create({
          data: {
            projectVersionId: version.id,
            fileId: storedFile.id,
            documentType,
            checksum: storedFile.checksum ?? '',
          },
          select: { id: true },
        });
        await tx.trainingJob.create({
          data: {
            kind: TrainingJobKind.EXTRACT_SOURCE_DOCUMENT,
            payloadJson: { sourceDocumentId: document.id },
            idempotencyKey: `extract-source-document:${document.id}:initial`,
          },
        });
        await this.writeAudit(tx, {
          action: 'training.source-document.upload',
          actor,
          request,
          entityId: document.id,
          metadata: {
            projectVersionId: version.id,
            fileId: storedFile.id,
            documentType,
            originalName: storedFile.originalName,
          },
        });

        return document.id;
      });
    } catch (error) {
      await this.files.deleteStoredFile(storedFile).catch(() => undefined);
      await this.prisma.file.delete({ where: { id: storedFile.id } }).catch(() => undefined);

      if (isPrismaUniqueError(error)) {
        throw new ConflictException('This document is already attached to the draft');
      }
      throw error;
    }

    return this.getDocument(version.id, documentId);
  }

  async updateManualText(
    versionIdInput: string,
    documentIdInput: string,
    body: Record<string, unknown>,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    this.assertOnlyFields(body, ['extractedText']);
    const version = await this.requireDraftVersion(versionIdInput);
    const documentId = this.parseUuid(documentIdInput, 'Training document is invalid');
    const document = await this.prisma.trainingSourceDocument.findFirst({
      where: { id: documentId, projectVersionId: version.id },
      select: { id: true, extractionStatus: true },
    });

    if (!document) {
      throw new NotFoundException('Training document not found');
    }
    if (
      document.extractionStatus === TrainingSourceExtractionStatus.PENDING ||
      document.extractionStatus === TrainingSourceExtractionStatus.PROCESSING
    ) {
      throw new ConflictException('Wait until automatic document extraction finishes');
    }
    if (typeof body.extractedText !== 'string') {
      throw new BadRequestException('Extracted text must be a string');
    }

    const extractedText = body.extractedText.replace(/\u0000/gu, '').trim();

    if (extractedText.length > TRAINING_MAX_EXTRACTED_CHARACTERS) {
      throw new BadRequestException(
        `Extracted text cannot exceed ${TRAINING_MAX_EXTRACTED_CHARACTERS} characters`,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.trainingSourceDocument.update({
        where: { id: document.id },
        data: {
          extractedText: extractedText || null,
          extractionStatus: extractedText
            ? TrainingSourceExtractionStatus.READY
            : TrainingSourceExtractionStatus.NEEDS_MANUAL_TEXT,
          extractionMetadataJson: {
            source: 'admin_manual',
            segments: [],
            truncated: false,
          },
          errorMessage: null,
        },
      });
      await this.writeAudit(tx, {
        action: 'training.source-document.text.update',
        actor,
        request,
        entityId: document.id,
        metadata: {
          projectVersionId: version.id,
          characterCount: extractedText.length,
          scoringEligible: false,
        },
      });
    });

    return this.getDocument(version.id, document.id);
  }

  async retryDocument(
    versionIdInput: string,
    documentIdInput: string,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const version = await this.requireDraftVersion(versionIdInput);
    const documentId = this.parseUuid(documentIdInput, 'Training document is invalid');
    const document = await this.prisma.trainingSourceDocument.findFirst({
      where: { id: documentId, projectVersionId: version.id },
    });

    if (!document) {
      throw new NotFoundException('Training document not found');
    }
    if (document.extractionStatus === TrainingSourceExtractionStatus.PROCESSING) {
      throw new ConflictException('Document extraction is already running');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.trainingSourceDocument.update({
        where: { id: document.id },
        data: {
          extractionStatus: TrainingSourceExtractionStatus.PENDING,
          extractedText: null,
          extractionMetadataJson: {},
          errorMessage: null,
        },
      });
      await tx.trainingJob.create({
        data: {
          kind: TrainingJobKind.EXTRACT_SOURCE_DOCUMENT,
          status: TrainingJobStatus.PENDING,
          payloadJson: { sourceDocumentId: document.id },
          idempotencyKey: `extract-source-document:${document.id}:retry:${randomUUID()}`,
        },
      });
      await this.writeAudit(tx, {
        action: 'training.source-document.retry',
        actor,
        request,
        entityId: document.id,
        metadata: { projectVersionId: version.id },
      });
    });

    return this.getDocument(version.id, document.id);
  }

  async deleteDocument(
    versionIdInput: string,
    documentIdInput: string,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const version = await this.requireDraftVersion(versionIdInput);
    const documentId = this.parseUuid(documentIdInput, 'Training document is invalid');
    const document = await this.prisma.trainingSourceDocument.findFirst({
      where: { id: documentId, projectVersionId: version.id },
      include: {
        file: true,
      },
    });

    if (!document) {
      throw new NotFoundException('Training document not found');
    }
    if (document.extractionStatus === TrainingSourceExtractionStatus.PROCESSING) {
      throw new ConflictException('Processing document cannot be deleted');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.trainingSourceDocument.delete({ where: { id: document.id } });
      await this.writeAudit(tx, {
        action: 'training.source-document.delete',
        actor,
        request,
        entityId: document.id,
        metadata: {
          projectVersionId: version.id,
          fileId: document.fileId,
          originalName: document.file.originalName,
        },
      });
    });
    await this.files.deleteUnlinkedFile(document.fileId);
  }

  async getDocumentContent(versionIdInput: string, documentIdInput: string) {
    const versionId = this.parseUuid(versionIdInput, 'Training version is invalid');
    const documentId = this.parseUuid(documentIdInput, 'Training document is invalid');
    const document = await this.prisma.trainingSourceDocument.findFirst({
      where: { id: documentId, projectVersionId: versionId },
      include: { file: true },
    });

    if (!document) {
      throw new NotFoundException('Training document not found');
    }

    return {
      file: document.file,
      buffer: await this.files.readStoredFile(document.file),
    };
  }

  private async getDocument(versionId: string, documentId: string | null) {
    if (!documentId) {
      throw new NotFoundException('Training document not found');
    }
    const document = await this.prisma.trainingSourceDocument.findFirst({
      where: { id: documentId, projectVersionId: versionId },
      include: documentInclude,
    });

    if (!document) {
      throw new NotFoundException('Training document not found');
    }

    return { document: this.serializeDocument(document) };
  }

  private async findDocument(versionIdInput: string, documentIdInput: string) {
    const versionId = this.parseUuid(versionIdInput, 'Training version is invalid');
    const documentId = this.parseUuid(documentIdInput, 'Training document is invalid');
    const document = await this.prisma.trainingSourceDocument.findFirst({
      where: { id: documentId, projectVersionId: versionId },
      include: documentInclude,
    });

    if (!document) {
      throw new NotFoundException('Training document not found');
    }

    return document;
  }

  private async requireVersion(id: string) {
    const versionId = this.parseUuid(id, 'Training version is invalid');
    const version = await this.prisma.trainingProjectVersion.findUnique({
      where: { id: versionId },
      select: { id: true, status: true },
    });

    if (!version) {
      throw new NotFoundException('Training version not found');
    }

    return version;
  }

  private async requireDraftVersion(id: string) {
    const version = await this.requireVersion(id);

    if (version.status !== TrainingVersionStatus.DRAFT) {
      throw new ConflictException('Published training version is immutable; create a new draft');
    }

    return version;
  }

  private validateUpload(
    file: UploadedFile | undefined,
  ): UploadedFile & { buffer: Buffer } {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new BadRequestException('Document file is required');
    }
    if (file.buffer.length > TRAINING_MAX_DOCUMENT_BYTES) {
      throw new BadRequestException(
        `Document size cannot exceed ${TRAINING_MAX_DOCUMENT_BYTES} bytes`,
      );
    }

    const originalname = basename(file.originalname || 'document');
    const extension = extname(originalname).toLocaleLowerCase('en-US');
    const mimetype = file.mimetype.trim().toLocaleLowerCase('en-US').split(';')[0] ?? '';
    const supportedExtension = Object.values(TRAINING_DOCUMENT_EXTENSIONS).includes(
      extension as (typeof TRAINING_DOCUMENT_EXTENSIONS)[keyof typeof TRAINING_DOCUMENT_EXTENSIONS],
    );

    if (!supportedExtension) {
      throw new BadRequestException('Only PDF, DOCX, PPTX and XLSX documents are allowed');
    }
    if (extension === '.pdf' && !file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new BadRequestException('PDF signature is invalid');
    }
    if (
      extension !== '.pdf' &&
      !file.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    ) {
      throw new BadRequestException('OOXML ZIP signature is invalid');
    }

    return {
      ...file,
      originalname,
      mimetype,
      size: file.buffer.length,
      buffer: file.buffer,
    };
  }

  private resolveDocumentType(
    file: UploadedFile & { buffer: Buffer },
  ): TrainingSourceDocumentType {
    const extension = extname(file.originalname).toLocaleLowerCase('en-US');

    for (const type of Object.values(TrainingSourceDocumentType)) {
      if (TRAINING_DOCUMENT_EXTENSIONS[type] !== extension) continue;
      const allowedMimeTypes = TRAINING_DOCUMENT_MIME_TYPES[type] as readonly string[];

      if (!allowedMimeTypes.includes(file.mimetype)) {
        throw new BadRequestException(
          `MIME type does not match the ${TRAINING_DOCUMENT_EXTENSIONS[type]} extension`,
        );
      }

      return type;
    }

    throw new BadRequestException('Training document type is not supported');
  }

  private serializeDocument(document: TrainingDocumentRecord) {
    return {
      id: document.id,
      projectVersionId: document.projectVersionId,
      documentType: document.documentType,
      checksum: document.checksum,
      extractionStatus: document.extractionStatus,
      errorMessage: document.errorMessage,
      extractedCharacterCount: document.extractedText?.length ?? 0,
      textPreview: document.extractedText?.slice(0, 500) ?? '',
      linkedFactCount: document._count.facts,
      file: {
        id: document.file.id,
        originalName: document.file.originalName,
        mimeType: document.file.mimeType,
        sizeBytes: document.file.sizeBytes?.toString() ?? null,
      },
      createdAt: document.createdAt.toISOString(),
      updatedAt: document.updatedAt.toISOString(),
    };
  }

  private assertOnlyFields(body: Record<string, unknown>, allowedFields: string[]) {
    const unsupported = Object.keys(body).filter((key) => !allowedFields.includes(key));

    if (unsupported.length > 0) {
      throw new BadRequestException(`Unsupported fields: ${unsupported.join(', ')}`);
    }
  }

  private parseUuid(value: string, message: string) {
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

    if (!uuidPattern.test(value)) {
      throw new BadRequestException(message);
    }

    return value;
  }

  private async writeAudit(
    tx: Prisma.TransactionClient,
    input: {
      action: string;
      actor: AuthenticatedUser;
      request: TrainingAuditRequest;
      entityId: string;
      metadata: Prisma.InputJsonValue;
    },
  ) {
    await tx.auditLog.create({
      data: {
        action: input.action,
        actorUserId: input.actor.id,
        entityType: 'training_source_document',
        entityId: input.entityId,
        metadata: input.metadata,
        ipAddress: input.request.ip ?? input.request.socket?.remoteAddress ?? null,
        userAgent: Array.isArray(input.request.headers?.['user-agent'])
          ? input.request.headers['user-agent'].join(', ')
          : input.request.headers?.['user-agent'] ?? null,
      },
    });
  }
}

function isPrismaUniqueError(error: unknown) {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
