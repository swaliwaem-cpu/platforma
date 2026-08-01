import { basename, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FileStorage,
  Prisma,
  ObjectFileType,
  TrainingFactSuggestionRunStatus,
  TrainingJobKind,
  TrainingJobStatus,
  TrainingProjectStatus,
  TrainingSourceDocumentType,
  TrainingSourceExtractionStatus,
  TrainingSourceOriginKind,
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
import { lockTrainingVersionForContentMutation } from './training-version-lock';
import { isTrainingUuid } from './training-uuid';

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

const linkedObjectPdfMimeType = 'application/pdf';
const maxLinkedObjectPdfBatchSize = 10;
const sha256Pattern = /^[0-9a-f]{64}$/iu;

type LinkedObjectPdfFile = {
  id: string;
  storage: FileStorage;
  bucket: string | null;
  key: string;
  originalName: string | null;
  mimeType: string | null;
  sizeBytes: bigint | null;
  checksum: string | null;
  createdAt: Date;
  updatedAt: Date;
};

@Injectable()
export class TrainingDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
  ) {}

  async listRealEstateObjects(query: Record<string, string | undefined>) {
    const page = this.parsePositiveInteger(query.page, 'Page', 1);
    const limit = this.parsePositiveInteger(query.limit, 'Limit', 30, 100);
    const search = this.parseOptionalQueryString(query.search, 'Search', 200);
    const hasPdf = this.parseOptionalBoolean(query.hasPdf, 'hasPdf');
    const pdfFileWhere: Prisma.ObjectFileWhereInput = {
      file: {
        mimeType: linkedObjectPdfMimeType,
      },
    };
    const where: Prisma.RealEstateObjectWhereInput = {
      deletedAt: null,
      ...(search
        ? {
            OR: [
              { title: { contains: search, mode: 'insensitive' as const } },
              { slug: { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      ...(hasPdf === undefined
        ? {}
        : hasPdf
          ? { files: { some: pdfFileWhere } }
          : { files: { none: pdfFileWhere } }),
    };
    const [objects, total] = await Promise.all([
      this.prisma.realEstateObject.findMany({
        where,
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          title: true,
          slug: true,
          status: true,
          files: {
            where: pdfFileWhere,
            select: {
              file: {
                select: {
                  storage: true,
                  bucket: true,
                  key: true,
                  mimeType: true,
                  sizeBytes: true,
                  checksum: true,
                },
              },
            },
          },
        },
      }),
      this.prisma.realEstateObject.count({ where }),
    ]);

    return {
      items: objects.map(({ files, ...object }) => ({
        ...object,
        pdfCount: files.length,
        eligiblePdfCount: files.filter(({ file }) =>
          this.getLinkedPdfEligibilityError(file) === null,
        ).length,
      })),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async listLinkedObjectPdfs(versionIdInput: string) {
    const context = await this.requireDraftLinkedObjectContext(versionIdInput);

    if (!context.realEstateObject) {
      return {
        realEstateObject: null,
        items: [],
      };
    }

    const objectFiles = await this.prisma.objectFile.findMany({
      where: {
        objectId: context.realEstateObject.id,
        file: {
          mimeType: linkedObjectPdfMimeType,
        },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        type: true,
        title: true,
        sortOrder: true,
        file: {
          select: {
            id: true,
            storage: true,
            bucket: true,
            key: true,
            originalName: true,
            mimeType: true,
            sizeBytes: true,
            checksum: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
    const fileIds = [...new Set(objectFiles.map((item) => item.file.id))];
    const checksums = [
      ...new Set(
        objectFiles
          .map((item) => item.file.checksum?.toLocaleLowerCase('en-US') ?? '')
          .filter((checksum) => sha256Pattern.test(checksum)),
      ),
    ];
    const attachedDocuments =
      fileIds.length === 0
        ? []
        : await this.prisma.trainingSourceDocument.findMany({
            where: {
              projectVersionId: context.versionId,
              OR: [
                { fileId: { in: fileIds } },
                ...(checksums.length > 0
                  ? [{ checksum: { in: checksums } }]
                  : []),
              ],
            },
            select: {
              id: true,
              fileId: true,
              checksum: true,
            },
          });
    const documentByFileId = new Map(
      attachedDocuments.map((document) => [document.fileId, document]),
    );
    const documentByChecksum = new Map(
      attachedDocuments.map((document) => [
        document.checksum.toLocaleLowerCase('en-US'),
        document,
      ]),
    );

    return {
      realEstateObject: context.realEstateObject,
      items: objectFiles.map((objectFile) => {
        const checksum =
          objectFile.file.checksum?.toLocaleLowerCase('en-US') ?? '';
        const sourceDocument =
          documentByFileId.get(objectFile.file.id) ??
          (sha256Pattern.test(checksum)
            ? documentByChecksum.get(checksum)
            : undefined);
        const eligibilityError = this.getLinkedPdfEligibilityError(
          objectFile.file,
        );

        return {
          objectFileId: objectFile.id,
          type: objectFile.type,
          title: objectFile.title,
          sortOrder: objectFile.sortOrder,
          recommendedByDefault:
            objectFile.type === ObjectFileType.PRESENTATION ||
            objectFile.type === ObjectFileType.DOCUMENT,
          eligible: eligibilityError === null,
          eligibilityError,
          alreadyAttached: Boolean(sourceDocument),
          sourceDocumentId: sourceDocument?.id ?? null,
          file: {
            id: objectFile.file.id,
            originalName: objectFile.file.originalName,
            mimeType: objectFile.file.mimeType,
            sizeBytes: objectFile.file.sizeBytes?.toString() ?? null,
            createdAt: objectFile.file.createdAt.toISOString(),
          },
        };
      }),
    };
  }

  async attachLinkedObjectPdfs(
    versionIdInput: string,
    body: Record<string, unknown>,
    actor: AuthenticatedUser,
    request: TrainingAuditRequest,
  ) {
    const objectFileIds = this.parseObjectFileIds(body);
    const context = await this.requireDraftLinkedObjectContext(versionIdInput);

    if (!context.realEstateObject) {
      throw new ConflictException(
        'Select a linked real estate object before attaching its PDFs',
      );
    }
    const linkedObjectId = context.realEstateObject.id;

    const objectFiles = await this.prisma.objectFile.findMany({
      where: {
        id: { in: objectFileIds },
        objectId: linkedObjectId,
      },
      select: {
        id: true,
        objectId: true,
        type: true,
        title: true,
        fileId: true,
        file: {
          select: {
            id: true,
            storage: true,
            bucket: true,
            key: true,
            originalName: true,
            mimeType: true,
            sizeBytes: true,
            checksum: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
    const objectFileById = new Map(objectFiles.map((item) => [item.id, item]));

    if (objectFileIds.some((id) => !objectFileById.has(id))) {
      throw new NotFoundException(
        'Linked object PDF not found for the selected real estate object',
      );
    }

    const validatedFiles = new Map<
      string,
      { checksum: string; file: LinkedObjectPdfFile }
    >();
    for (const objectFileId of objectFileIds) {
      const objectFile = objectFileById.get(objectFileId)!;
      let validated = validatedFiles.get(objectFile.file.id);

      if (!validated) {
        const checksum = await this.validateLinkedPdfContent(objectFile.file);
        validated = { checksum, file: objectFile.file };
        validatedFiles.set(objectFile.file.id, validated);
      }
    }

    const selectedAt = new Date().toISOString();
    const transactionResult = await this.prisma.$transaction(async (tx) => {
      const lockedVersion = await this.assertDraftVersionLocked(
        tx,
        context.versionId,
      );
      const lockedProject = await tx.trainingProject.findUnique({
        where: { id: lockedVersion.projectId },
        select: {
          realEstateObjectId: true,
          realEstateObject: {
            select: {
              id: true,
              title: true,
              slug: true,
              deletedAt: true,
            },
          },
        },
      });

      if (
        !lockedProject?.realEstateObject ||
        lockedProject.realEstateObject.deletedAt !== null ||
        lockedProject.realEstateObjectId !== linkedObjectId
      ) {
        throw new ConflictException(
          'The linked real estate object changed; reload the draft before attaching PDFs',
        );
      }

      const currentObjectFiles = await tx.objectFile.findMany({
        where: {
          id: { in: objectFileIds },
          objectId: lockedProject.realEstateObject.id,
        },
        select: {
          id: true,
          objectId: true,
          type: true,
          title: true,
          fileId: true,
          file: {
            select: {
              id: true,
              storage: true,
              bucket: true,
              key: true,
              originalName: true,
              mimeType: true,
              sizeBytes: true,
              checksum: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
      });
      const currentObjectFileById = new Map(
        currentObjectFiles.map((item) => [item.id, item]),
      );
      const results: Array<{
        objectFileId: string;
        documentId: string;
        alreadyAttached: boolean;
      }> = [];

      for (const objectFileId of objectFileIds) {
        const originalObjectFile = objectFileById.get(objectFileId)!;
        const currentObjectFile = currentObjectFileById.get(objectFileId);
        const validated = validatedFiles.get(originalObjectFile.file.id)!;

        if (
          !currentObjectFile ||
          !this.hasSameLinkedPdfStorageMetadata(
            originalObjectFile.file,
            currentObjectFile.file,
          ) ||
          currentObjectFile.fileId !== originalObjectFile.fileId
        ) {
          throw new ConflictException(
            'A linked PDF changed while it was being checked; reload and try again',
          );
        }

        const documentId = randomUUID();
        const created = await tx.trainingSourceDocument.createMany({
          data: [
            {
              id: documentId,
              projectVersionId: context.versionId,
              fileId: currentObjectFile.fileId,
              documentType: TrainingSourceDocumentType.PDF,
              originKind: TrainingSourceOriginKind.LINKED_OBJECT_PDF,
              originMetadataJson: {
                objectId: lockedProject.realEstateObject.id,
                objectTitle: lockedProject.realEstateObject.title,
                objectSlug: lockedProject.realEstateObject.slug,
                objectFileId: currentObjectFile.id,
                objectFileType: currentObjectFile.type,
                ...(currentObjectFile.title
                  ? { objectFileTitle: currentObjectFile.title }
                  : {}),
                selectedAt,
                selectedByUserId: actor.id,
                ...(currentObjectFile.file.originalName
                  ? { originalName: currentObjectFile.file.originalName }
                  : {}),
              },
              checksum: validated.checksum,
            },
          ],
          skipDuplicates: true,
        });

        if (created.count === 0) {
          const existing = await tx.trainingSourceDocument.findFirst({
            where: {
              projectVersionId: context.versionId,
              OR: [
                { fileId: currentObjectFile.fileId },
                { checksum: validated.checksum },
              ],
            },
            select: { id: true },
          });
          if (!existing) {
            throw new ConflictException(
              'The linked PDF could not be attached idempotently',
            );
          }
          results.push({
            objectFileId,
            documentId: existing.id,
            alreadyAttached: true,
          });
          continue;
        }

        await tx.trainingJob.create({
          data: {
            kind: TrainingJobKind.EXTRACT_SOURCE_DOCUMENT,
            status: TrainingJobStatus.PENDING,
            payloadJson: { sourceDocumentId: documentId },
            idempotencyKey: `extract-source-document:${documentId}:initial`,
          },
        });
        await this.writeAudit(tx, {
          action: 'training.source-document.linked-object.attach',
          actor,
          request,
          entityId: documentId,
          metadata: {
            projectVersionId: context.versionId,
            realEstateObjectId: lockedProject.realEstateObject.id,
            objectFileId: currentObjectFile.id,
            fileId: currentObjectFile.fileId,
            checksum: validated.checksum,
          },
        });
        results.push({
          objectFileId,
          documentId,
          alreadyAttached: false,
        });
      }

      return results;
    });
    const documents = await this.prisma.trainingSourceDocument.findMany({
      where: {
        id: {
          in: [...new Set(transactionResult.map((item) => item.documentId))],
        },
        projectVersionId: context.versionId,
      },
      include: documentInclude,
    });
    const documentById = new Map(documents.map((item) => [item.id, item]));

    return {
      items: transactionResult.map((item) => {
        const document = documentById.get(item.documentId);
        if (!document) {
          throw new ConflictException(
            'The attached training document changed; reload the draft',
          );
        }
        return {
          objectFileId: item.objectFileId,
          alreadyAttached: item.alreadyAttached,
          document: this.serializeDocument(document),
        };
      }),
      createdCount: transactionResult.filter(
        (item) => !item.alreadyAttached,
      ).length,
    };
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
        await this.assertDraftVersionLocked(tx, version.id);
        const document = await tx.trainingSourceDocument.create({
          data: {
            projectVersionId: version.id,
            fileId: storedFile.id,
            documentType,
            originKind: TrainingSourceOriginKind.UPLOAD,
            originMetadataJson: {
              uploadedAt: new Date().toISOString(),
              uploadedByUserId: actor.id,
              originalName: storedFile.originalName,
            },
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
      await this.assertDraftVersionLocked(tx, version.id);
      await tx.$queryRaw`SELECT "id" FROM "training_source_documents" WHERE "id" = ${documentId}::uuid FOR UPDATE`;
      const lockedDocument = await tx.trainingSourceDocument.findFirst({
        where: { id: documentId, projectVersionId: version.id },
        select: { id: true, extractionStatus: true },
      });
      if (!lockedDocument) {
        throw new NotFoundException('Training document not found');
      }
      if (
        lockedDocument.extractionStatus ===
          TrainingSourceExtractionStatus.PENDING ||
        lockedDocument.extractionStatus ===
          TrainingSourceExtractionStatus.PROCESSING
      ) {
        throw new ConflictException(
          'Wait until automatic document extraction finishes',
        );
      }
      await tx.trainingSourceDocument.update({
        where: { id: lockedDocument.id },
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
      await this.assertDraftVersionLocked(tx, version.id);
      await tx.$queryRaw`SELECT "id" FROM "training_source_documents" WHERE "id" = ${documentId}::uuid FOR UPDATE`;
      const lockedDocument = await tx.trainingSourceDocument.findFirst({
        where: { id: documentId, projectVersionId: version.id },
        select: { id: true, extractionStatus: true },
      });
      if (!lockedDocument) {
        throw new NotFoundException('Training document not found');
      }
      if (
        lockedDocument.extractionStatus ===
        TrainingSourceExtractionStatus.PROCESSING
      ) {
        throw new ConflictException('Document extraction is already running');
      }
      await tx.trainingSourceDocument.update({
        where: { id: lockedDocument.id },
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
          payloadJson: { sourceDocumentId: lockedDocument.id },
          idempotencyKey: `extract-source-document:${lockedDocument.id}:retry:${randomUUID()}`,
        },
      });
      await this.writeAudit(tx, {
        action: 'training.source-document.retry',
        actor,
        request,
        entityId: lockedDocument.id,
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
    let fileId: string | null = null;

    await this.prisma.$transaction(async (tx) => {
      await this.assertDraftVersionLocked(tx, version.id);
      await tx.$queryRaw`SELECT "id" FROM "training_source_documents" WHERE "id" = ${documentId}::uuid FOR UPDATE`;
      const document = await tx.trainingSourceDocument.findFirst({
        where: { id: documentId, projectVersionId: version.id },
        include: {
          file: true,
          _count: {
            select: {
              facts: true,
            },
          },
        },
      });
      if (!document) {
        throw new NotFoundException('Training document not found');
      }
      if (
        document.extractionStatus ===
        TrainingSourceExtractionStatus.PROCESSING
      ) {
        throw new ConflictException('Processing document cannot be deleted');
      }
      if (document._count.facts > 0) {
        throw new ConflictException(
          'Remove this document from linked facts before deleting it',
        );
      }

      const activeFactSuggestionRunCount =
        await tx.trainingFactSuggestionRun.count({
          where: {
            projectVersionId: version.id,
            status: {
              in: [
                TrainingFactSuggestionRunStatus.PENDING,
                TrainingFactSuggestionRunStatus.RUNNING,
              ],
            },
            sourceSnapshotJson: {
              array_contains: [
                {
                  kind: 'DOCUMENT',
                  id: document.id,
                },
              ],
            },
          },
        });
      if (activeFactSuggestionRunCount > 0) {
        throw new ConflictException(
          'Предложения фактов по этому документу ещё обрабатываются',
        );
      }

      const factSuggestionHistoryCount =
        await tx.trainingFactSuggestionProviderRun.count({
          where: { sourceDocumentId: document.id },
        });
      if (factSuggestionHistoryCount > 0) {
        throw new ConflictException(
          'Документ использовался для предложений фактов и не может быть удалён: история решений должна быть сохранена',
        );
      }

      const liveJobs = await tx.trainingJob.count({
        where: {
          kind: TrainingJobKind.EXTRACT_SOURCE_DOCUMENT,
          status: {
            in: [TrainingJobStatus.PENDING, TrainingJobStatus.RUNNING],
          },
          payloadJson: {
            path: ['sourceDocumentId'],
            equals: document.id,
          },
        },
      });
      if (liveJobs > 0) {
        throw new ConflictException(
          'Document has an active extraction job and cannot be deleted',
        );
      }

      fileId = document.fileId;
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
    if (fileId) {
      await this.files.deleteUnlinkedFile(fileId);
    }
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

  private async requireDraftLinkedObjectContext(versionIdInput: string) {
    const versionId = this.parseUuid(
      versionIdInput,
      'Training version is invalid',
    );
    const version = await this.prisma.trainingProjectVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        status: true,
        project: {
          select: {
            realEstateObject: {
              select: {
                id: true,
                title: true,
                slug: true,
                status: true,
                deletedAt: true,
              },
            },
          },
        },
      },
    });

    if (!version) {
      throw new NotFoundException('Training version not found');
    }
    if (version.status !== TrainingVersionStatus.DRAFT) {
      throw new ConflictException(
        'Published training version is immutable; create a new draft',
      );
    }

    const realEstateObject =
      version.project.realEstateObject?.deletedAt === null
        ? {
            id: version.project.realEstateObject.id,
            title: version.project.realEstateObject.title,
            slug: version.project.realEstateObject.slug,
            status: version.project.realEstateObject.status,
          }
        : null;

    return {
      versionId: version.id,
      realEstateObject,
    };
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

  private async assertDraftVersionLocked(
    tx: Prisma.TransactionClient,
    versionId: string,
  ) {
    const version = await lockTrainingVersionForContentMutation(tx, versionId);
    if (!version) {
      throw new NotFoundException('Training version not found');
    }
    if (
      version.status !== TrainingVersionStatus.DRAFT ||
      version.projectStatus === TrainingProjectStatus.ARCHIVED
    ) {
      throw new ConflictException(
        'Published training version is immutable; open its working version',
      );
    }

    return version;
  }

  private async validateLinkedPdfContent(file: LinkedObjectPdfFile) {
    const eligibilityError = this.getLinkedPdfEligibilityError(file);
    if (eligibilityError) {
      throw new ConflictException(
        `Linked object PDF is not eligible: ${eligibilityError}`,
      );
    }

    const buffer = await this.files.readStoredFile(file);
    if (
      buffer.length === 0 ||
      buffer.length > TRAINING_MAX_DOCUMENT_BYTES ||
      BigInt(buffer.length) !== file.sizeBytes
    ) {
      throw new ConflictException(
        'Linked object PDF size does not match its stored metadata',
      );
    }
    if (!buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new ConflictException('Linked object PDF signature is invalid');
    }

    const checksum = createHash('sha256').update(buffer).digest('hex');
    if (checksum !== file.checksum?.toLocaleLowerCase('en-US')) {
      throw new ConflictException(
        'Linked object PDF checksum does not match its stored metadata',
      );
    }

    return checksum;
  }

  private getLinkedPdfEligibilityError(
    file: Pick<
      LinkedObjectPdfFile,
      'storage' | 'bucket' | 'key' | 'mimeType' | 'sizeBytes' | 'checksum'
    >,
  ) {
    if (
      file.mimeType?.trim().toLocaleLowerCase('en-US') !==
      linkedObjectPdfMimeType
    ) {
      return 'INVALID_MIME_TYPE';
    }
    if (
      file.bucket === null ||
      file.bucket.length === 0 ||
      file.bucket.length > 255 ||
      file.bucket !== file.bucket.trim() ||
      /[/\\\u0000-\u001f\u007f]/u.test(file.bucket) ||
      file.key.length === 0 ||
      file.key.length > 1024 ||
      file.key !== file.key.trim() ||
      file.key.startsWith('/') ||
      file.key.includes('\\') ||
      /[\u0000-\u001f\u007f]/u.test(file.key) ||
      file.key
        .split('/')
        .some(
          (segment) =>
            segment.length === 0 || segment === '.' || segment === '..',
        )
    ) {
      return 'INVALID_STORAGE_METADATA';
    }
    if (
      file.sizeBytes === null ||
      file.sizeBytes <= 0n ||
      file.sizeBytes > BigInt(TRAINING_MAX_DOCUMENT_BYTES)
    ) {
      return 'INVALID_SIZE';
    }
    if (!file.checksum || !sha256Pattern.test(file.checksum)) {
      return 'INVALID_CHECKSUM';
    }

    return null;
  }

  private hasSameLinkedPdfStorageMetadata(
    expected: LinkedObjectPdfFile,
    current: LinkedObjectPdfFile,
  ) {
    return (
      expected.id === current.id &&
      expected.storage === current.storage &&
      expected.bucket === current.bucket &&
      expected.key === current.key &&
      expected.originalName === current.originalName &&
      expected.mimeType === current.mimeType &&
      expected.sizeBytes === current.sizeBytes &&
      expected.checksum === current.checksum &&
      expected.updatedAt.getTime() === current.updatedAt.getTime()
    );
  }

  private parseObjectFileIds(body: Record<string, unknown>) {
    this.assertOnlyFields(body, ['objectFileId', 'objectFileIds']);
    const hasSingle = Object.prototype.hasOwnProperty.call(body, 'objectFileId');
    const hasBatch = Object.prototype.hasOwnProperty.call(body, 'objectFileIds');

    if (hasSingle === hasBatch) {
      throw new BadRequestException(
        'Provide exactly one of objectFileId or objectFileIds',
      );
    }

    const rawIds = hasSingle ? [body.objectFileId] : body.objectFileIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      throw new BadRequestException(
        'At least one linked object PDF must be selected',
      );
    }
    if (rawIds.length > maxLinkedObjectPdfBatchSize) {
      throw new BadRequestException(
        `No more than ${maxLinkedObjectPdfBatchSize} linked object PDFs can be attached at once`,
      );
    }

    return [
      ...new Set(
        rawIds.map((value) => {
          if (typeof value !== 'string') {
            throw new BadRequestException('Linked object PDF is invalid');
          }
          return this.parseUuid(value, 'Linked object PDF is invalid');
        }),
      ),
    ];
  }

  private parsePositiveInteger(
    value: unknown,
    label: string,
    fallback: number,
    max = Number.MAX_SAFE_INTEGER,
  ) {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d+$/u.test(value)
          ? Number(value)
          : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
      throw new BadRequestException(
        `${label} must be an integer between 1 and ${max}`,
      );
    }
    return parsed;
  }

  private parseOptionalQueryString(
    value: unknown,
    label: string,
    maxLength: number,
  ) {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (typeof value !== 'string') {
      throw new BadRequestException(`${label} must be a string`);
    }
    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength) {
      throw new BadRequestException(
        `${label} must contain between 1 and ${maxLength} characters`,
      );
    }
    return normalized;
  }

  private parseOptionalBoolean(value: unknown, label: string) {
    if (value === undefined || value === null || value === '') {
      return undefined;
    }
    if (value === true || value === 'true') {
      return true;
    }
    if (value === false || value === 'false') {
      return false;
    }
    throw new BadRequestException(`${label} must be true or false`);
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
      originKind: document.originKind,
      originMetadata: document.originMetadataJson,
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
    if (!isTrainingUuid(value)) {
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
