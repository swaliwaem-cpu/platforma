import { createHash, randomUUID } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  FileStorage,
  Prisma,
  TrainingFactSourceType,
  TrainingMaterialRevisionStatus,
  TrainingMaterialStatus,
  TrainingMaterialSuggestionStatus,
  TrainingMaterialType,
  TrainingProjectStatus,
  TrainingQuestionType,
} from '@prisma/client';
import type {
  ApplyTrainingMaterialSuggestionsRequest,
  TrainingMaterialDetail,
  TrainingMaterialRevision as TrainingMaterialRevisionContract,
  TrainingMaterialSegment,
} from '@platforma/shared' with { 'resolution-mode': 'import' };

import type { UploadedFile } from '../files/uploaded-file.type';
import { S3StorageService } from '../files/s3-storage.service';
import { findCatalogSearchObjectIds } from '../objects/object-search';
import { PrismaService } from '../prisma/prisma.service';
import {
  createTrainingMaterialDiff,
  isExactSegmentExcerpt,
  normalizeTrainingMaterialText,
  parseStoredSegments,
  TrainingMaterialExtractionService,
  type TrainingMaterialExtraction,
} from './training-material-extraction';
import {
  canonicalTrainingFact,
  TRAINING_MATERIAL_SUGGESTER,
  type TrainingMaterialSuggester,
  type TrainingQuestionDraftGenerationResult,
  type TrainingQuestionDraftSource,
  validateMaterialSuggestions,
} from './training-material-suggester';
import { recordTrainingProjectDeleteCleanupObject } from './training-project-cleanup';
import { TrainingUrlExtractor } from './training-url-extractor';

const DEFAULT_PDF_MAX_BYTES = 25 * 1024 * 1024;
const PLATFORM_OBJECT_IMPORT_KIND = 'PLATFORMA_OBJECT';
const OBJECT_FIELD_CODES = [
  'title',
  'type',
  'description',
  'architectureDescription',
  'infrastructureDescription',
  'fillingDescription',
  'krtName',
  'apartmentAreaRange',
  'ceilingHeight',
  'propertyClass',
  'floorRange',
  'completion',
  'address',
  'developer',
  'locations',
  'metroStations',
] as const;

const OBJECT_FIELD_LABELS: Record<ObjectFieldCode, string> = {
  title: 'Название',
  type: 'Тип объекта',
  description: 'Описание',
  architectureDescription: 'Архитектура',
  infrastructureDescription: 'Инфраструктура',
  fillingDescription: 'Отделка и наполнение',
  krtName: 'КРТ',
  apartmentAreaRange: 'Площади',
  ceilingHeight: 'Высота потолков',
  propertyClass: 'Класс',
  floorRange: 'Этажность',
  completion: 'Срок сдачи',
  address: 'Адрес',
  developer: 'Девелопер',
  locations: 'Районы',
  metroStations: 'Метро',
};

type ObjectFieldCode = typeof OBJECT_FIELD_CODES[number];

type ObjectSnapshotRecord = {
  id: string;
  title: string;
  type: string;
  description: string | null;
  architectureDescription: string | null;
  infrastructureDescription: string | null;
  fillingDescription: string | null;
  krtName: string | null;
  apartmentAreaRange: string | null;
  ceilingHeight: string | null;
  propertyClass: string | null;
  floorRange: string | null;
  completionYear: number | null;
  completionQuarter: number | null;
  address: string | null;
  developer: { name: string } | null;
  locations: Array<{ location: { name: string; type: string } }>;
  metroStations: Array<{ metroStation: { name: string; lineName: string | null } }>;
};

const materialInclude = {
  revisions: { orderBy: { revisionNumber: 'desc' as const } },
} as const satisfies Prisma.TrainingMaterialInclude;

type MaterialRecord = Prisma.TrainingMaterialGetPayload<{ include: typeof materialInclude }>;

@Injectable()
export class TrainingMaterialService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: S3StorageService,
    private readonly extraction: TrainingMaterialExtractionService,
    private readonly urlExtractor: TrainingUrlExtractor,
    @Inject(TRAINING_MATERIAL_SUGGESTER)
    private readonly suggester: TrainingMaterialSuggester,
  ) {}

  async list(projectId: string) {
    await this.requireProject(projectId);
    const materials = await this.prisma.trainingMaterial.findMany({
      where: { projectId },
      include: { revisions: { orderBy: { revisionNumber: 'desc' }, take: 1 } },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    });
    return { items: materials.map((material) => serializeMaterial(material)) };
  }

  async listObjectOptions(projectId: string, rawSearch: string | undefined) {
    const project = await this.prisma.trainingProject.findUnique({
      where: { id: projectId },
      select: { id: true, realEstateObjectId: true },
    });
    if (!project) throw new NotFoundException('Training project not found');

    const search = normalizeTrainingMaterialText(rawSearch ?? '');
    const matchingIds = search ? await findCatalogSearchObjectIds(this.prisma, search) : null;
    const options = await this.prisma.realEstateObject.findMany({
      where: {
        deletedAt: null,
        ...(matchingIds ? { id: { in: matchingIds } } : {}),
      },
      select: {
        id: true,
        title: true,
        status: true,
        developer: { select: { name: true } },
        files: {
          select: {
            id: true,
            file: { select: { mimeType: true, originalName: true } },
          },
        },
      },
      orderBy: { title: 'asc' },
      take: 30,
    });
    const selected = project.realEstateObjectId && !options.some((option) => option.id === project.realEstateObjectId)
      ? await this.prisma.realEstateObject.findFirst({
          where: { id: project.realEstateObjectId, deletedAt: null },
          select: {
            id: true,
            title: true,
            status: true,
            developer: { select: { name: true } },
            files: {
              select: {
                id: true,
                file: { select: { mimeType: true, originalName: true } },
              },
            },
          },
        })
      : options.find((option) => option.id === project.realEstateObjectId) ?? null;

    return {
      items: options.map(serializeObjectOption),
      selected: selected ? serializeObjectOption(selected) : null,
    };
  }

  async get(materialId: string): Promise<TrainingMaterialDetail> {
    const material = await this.findMaterial(materialId);
    return serializeMaterialDetail(material);
  }

  async createManual(projectId: string, actorId: string, title: string, text: string) {
    await this.requireEditableProject(projectId);
    const extraction = this.extraction.extractManual(text);
    return this.createMaterialWithRevision({
      projectId, actorId, title, type: TrainingMaterialType.MANUAL_TEXT, extraction,
    });
  }

  async createOfficialUrl(
    projectId: string,
    actorId: string,
    title: string,
    sourceUrl: string,
    officialConfirmed: boolean,
    replaceExistingQuestions = false,
  ) {
    if (!officialConfirmed) throw new BadRequestException('OFFICIAL_CONFIRMATION_REQUIRED');
    await this.requireEditableProject(projectId);
    await this.requireQuestionReplacementConfirmation(projectId, replaceExistingQuestions);
    const normalizedTitle = requiredTitle(title);
    const extracted = await this.urlExtractor.extract(sourceUrl);
    const materialId = randomUUID();
    const revisionId = randomUUID();
    const questionGeneration = await this.generateQuestionDraftsForSource({
      projectId,
      materialId,
      revisionId,
      title: normalizedTitle,
      type: TrainingMaterialType.OFFICIAL_URL,
      extraction: extracted,
    });
    await this.prisma.$transaction(async (transaction) => {
      await lockProject(transaction, projectId);
      await this.assertQuestionReplacementAllowed(
        transaction,
        projectId,
        replaceExistingQuestions,
      );
      await transaction.trainingMaterial.create({
        data: {
          id: materialId,
          projectId,
          createdById: actorId,
          title: normalizedTitle,
          type: TrainingMaterialType.OFFICIAL_URL,
          sourceUrl,
          officialConfirmedAt: new Date(),
          officialConfirmedById: actorId,
          revisions: { create: {
            id: revisionId,
            ...revisionCreateData({
              actorId,
              revisionNumber: 1,
              previousRevision: null,
              extraction: extracted,
              requestedUrl: sourceUrl,
              finalUrl: extracted.finalUrl,
              fetchedAt: extracted.fetchedAt,
            }),
          } },
        },
      });
      await this.upsertGeneratedQuestionDrafts(
        transaction,
        projectId,
        null,
        questionGeneration.generated,
        questionGeneration.sources,
      );
    });
    return this.get(materialId);
  }

  async createObjectSnapshot(
    projectId: string,
    actorId: string,
    title: string,
    fieldCodes: string[],
  ) {
    await this.requireEditableProject(projectId);
    const extraction = await this.extractObjectSnapshot(projectId, fieldCodes);
    return this.createMaterialWithRevision({
      projectId, actorId, title, type: TrainingMaterialType.OBJECT_SNAPSHOT, extraction,
    });
  }

  async importObjectContent(
    projectId: string,
    actorId: string,
    objectId: string,
    replaceExistingQuestions: boolean,
  ) {
    await this.requireEditableProject(projectId);
    await this.requireQuestionReplacementConfirmation(projectId, replaceExistingQuestions);

    const object = await this.prisma.realEstateObject.findFirst({
      where: { id: objectId, deletedAt: null },
      select: {
        id: true,
        title: true,
        status: true,
        description: true,
        type: true,
        architectureDescription: true,
        infrastructureDescription: true,
        fillingDescription: true,
        krtName: true,
        apartmentAreaRange: true,
        ceilingHeight: true,
        propertyClass: true,
        floorRange: true,
        completionYear: true,
        completionQuarter: true,
        address: true,
        developer: { select: { name: true } },
        locations: {
          select: { location: { select: { name: true, type: true } } },
          orderBy: { sortOrder: 'asc' },
        },
        metroStations: {
          select: { metroStation: { select: { name: true, lineName: true } } },
          orderBy: { sortOrder: 'asc' },
        },
        files: {
          select: {
            id: true,
            title: true,
            sortOrder: true,
            file: {
              select: {
                id: true,
                key: true,
                bucket: true,
                mimeType: true,
                originalName: true,
                sizeBytes: true,
              },
            },
          },
          orderBy: { sortOrder: 'asc' },
        },
      },
    });
    if (!object) throw new NotFoundException('Real estate object not found');

    await this.prisma.trainingProject.update({
      where: { id: projectId },
      data: { realEstateObjectId: object.id, status: TrainingProjectStatus.DRAFT },
    });

    const importedMaterials = await this.findObjectImportMaterials(projectId);
    const currentPdfObjectFileIds = new Set(
      object.files.filter(isPdfObjectFile).map((objectFile) => objectFile.id),
    );
    const obsoleteIds = importedMaterials
      .filter((material) => {
        const metadata = latestRevisionMetadata(material);
        if (metadata?.importKind !== PLATFORM_OBJECT_IMPORT_KIND) return false;
        if (metadata.objectId !== object.id) return true;
        return material.type === TrainingMaterialType.PDF &&
          typeof metadata.sourceObjectFileId === 'string' &&
          !currentPdfObjectFileIds.has(metadata.sourceObjectFileId);
      })
      .map((material) => material.id);
    if (obsoleteIds.length) {
      await this.prisma.trainingMaterial.updateMany({
        where: { id: { in: obsoleteIds } },
        data: { status: TrainingMaterialStatus.ARCHIVED },
      });
    }

    const snapshotExtraction = this.extractObjectSnapshotRecord(object, [...OBJECT_FIELD_CODES]);
    snapshotExtraction.metadata = {
      ...snapshotExtraction.metadata,
      importKind: PLATFORM_OBJECT_IMPORT_KIND,
    };
    const existingSnapshot = importedMaterials.find((material) => {
      const metadata = latestRevisionMetadata(material);
      return material.type === TrainingMaterialType.OBJECT_SNAPSHOT &&
        material.status === TrainingMaterialStatus.ACTIVE &&
        metadata?.importKind === PLATFORM_OBJECT_IMPORT_KIND && metadata.objectId === object.id;
    });
    const snapshotDetail = existingSnapshot
      ? await this.addRevision(existingSnapshot, actorId, snapshotExtraction)
      : await this.createMaterialWithRevision({
          projectId,
          actorId,
          title: `Карточка Platforma · ${object.title}`,
          type: TrainingMaterialType.OBJECT_SNAPSHOT,
          extraction: snapshotExtraction,
        });

    const questionSources: TrainingQuestionDraftSource[] = [questionSourceFromMaterial(snapshotDetail)];
    const importedPdfByObjectFileId = new Map(
      importedMaterials.flatMap((material) => {
        const metadata = latestRevisionMetadata(material);
        return material.type === TrainingMaterialType.PDF &&
          material.status === TrainingMaterialStatus.ACTIVE &&
          metadata?.importKind === PLATFORM_OBJECT_IMPORT_KIND &&
          metadata.objectId === object.id && typeof metadata.sourceObjectFileId === 'string'
          ? [[metadata.sourceObjectFileId, material] as const]
          : [];
      }),
    );
    const failedPdfTitles: string[] = [];
    let importedPdfCount = 0;

    for (const objectFile of object.files.filter(isPdfObjectFile)) {
      const pdfTitle = requiredTitle(
        objectFile.title || objectFile.file.originalName || `PDF · ${object.title}`,
      );
      const existing = importedPdfByObjectFileId.get(objectFile.id);
      try {
        const buffer = await this.storage.getObject(
          objectFile.file.key,
          objectFile.file.bucket ?? undefined,
        );
        const validated = validatePdf({
          buffer,
          fieldname: 'file',
          encoding: '7bit',
          mimetype: objectFile.file.mimeType ?? 'application/pdf',
          originalname: objectFile.file.originalName ?? `${pdfTitle}.pdf`,
          size: buffer.length,
        });
        let extraction: TrainingMaterialExtraction | null = null;
        let errorCode: string | undefined;
        try {
          extraction = await this.extraction.extractPdf(validated.buffer);
          extraction.metadata = {
            ...extraction.metadata,
            importKind: PLATFORM_OBJECT_IMPORT_KIND,
            objectId: object.id,
            objectTitle: object.title,
            sourceObjectFileId: objectFile.id,
            sourceFileId: objectFile.file.id,
          };
        } catch (error) {
          errorCode = safeErrorCode(error, 'PDF_EXTRACTION_FAILED');
        }
        const failureMetadata = {
          importKind: PLATFORM_OBJECT_IMPORT_KIND,
          objectId: object.id,
          objectTitle: object.title,
          sourceObjectFileId: objectFile.id,
          sourceFileId: objectFile.file.id,
        };
        const detail = existing
          ? await this.addPdfRevision(existing, actorId, validated, extraction, errorCode, failureMetadata)
          : await this.createPdfMaterial(
              projectId,
              actorId,
              pdfTitle,
              validated,
              extraction,
              errorCode,
              failureMetadata,
            );
        importedPdfCount += 1;
        if (detail.latestRevision?.status === TrainingMaterialRevisionStatus.READY) {
          questionSources.push(questionSourceFromMaterial(detail));
        } else {
          failedPdfTitles.push(pdfTitle);
        }
      } catch (error) {
        failedPdfTitles.push(pdfTitle);
        await this.recordObjectPdfReadFailure(
          projectId,
          actorId,
          pdfTitle,
          object.id,
          object.title,
          objectFile.id,
          objectFile.file.id,
          existing,
          safeErrorCode(error, 'OBJECT_PDF_READ_FAILED'),
        );
      }
    }

    const generated = await this.suggester.generateQuestionDrafts({
      projectId,
      objectId: object.id,
      objectTitle: object.title,
      sources: questionSources,
    });
    await this.applyGeneratedQuestionDrafts(
      projectId,
      object.id,
      generated,
      questionSources,
      replaceExistingQuestions,
    );

    return {
      object: serializeObjectOption({
        id: object.id,
        title: object.title,
        status: object.status,
        developer: object.developer,
        files: object.files,
      }),
      objectSnapshotMaterialId: snapshotDetail.id,
      importedPdfCount,
      failedPdfTitles,
      mainQuestion: generated.main.text,
      followUpQuestions: generated.followUps.map((question) => question.text),
      questionGenerationModel: generated.model,
      questionGenerationSourceChars: generated.sourceChars,
    };
  }

  async createPdf(
    projectId: string,
    actorId: string,
    title: string,
    file: UploadedFile | undefined,
    replaceExistingQuestions = false,
  ) {
    await this.requireEditableProject(projectId);
    await this.requireQuestionReplacementConfirmation(projectId, replaceExistingQuestions);
    const validated = validatePdf(file);
    const normalizedTitle = requiredTitle(title);
    let extraction: TrainingMaterialExtraction;
    try {
      extraction = await this.extraction.extractPdf(validated.buffer);
    } catch (error) {
      return this.createPdfMaterial(
        projectId,
        actorId,
        normalizedTitle,
        validated,
        null,
        safeErrorCode(error, 'PDF_EXTRACTION_FAILED'),
      );
    }
    const materialId = randomUUID();
    const revisionId = randomUUID();
    const questionGeneration = await this.generateQuestionDraftsForSource({
      projectId,
      materialId,
      revisionId,
      title: normalizedTitle,
      type: TrainingMaterialType.PDF,
      extraction,
    });
    const stored = await this.storePrivatePdf(materialId, revisionId, actorId, validated);
    try {
      await this.prisma.$transaction(async (transaction) => {
        await lockProject(transaction, projectId);
        await this.assertQuestionReplacementAllowed(
          transaction,
          projectId,
          replaceExistingQuestions,
        );
        await transaction.trainingMaterial.create({
          data: {
            id: materialId,
            projectId,
            createdById: actorId,
            title: normalizedTitle,
            type: TrainingMaterialType.PDF,
            revisions: { create: {
              id: revisionId,
              fileId: stored.id,
              ...revisionCreateData({
                actorId,
                revisionNumber: 1,
                previousRevision: null,
                extraction,
              }),
            } },
          },
        });
        await this.upsertGeneratedQuestionDrafts(
          transaction,
          projectId,
          null,
          questionGeneration.generated,
          questionGeneration.sources,
        );
      });
    } catch (error) {
      return this.cleanupPdfAfterFailedLink(projectId, stored, error);
    }
    return this.get(materialId);
  }

  async refresh(
    materialId: string,
    actorId: string,
    input: { text?: string; fieldCodes?: string[] },
  ) {
    const material = await this.findMaterial(materialId);
    await this.requireEditableProject(material.projectId);
    if (material.status !== TrainingMaterialStatus.ACTIVE) {
      throw new ConflictException('MATERIAL_ARCHIVED');
    }

    if (material.type === TrainingMaterialType.PDF) {
      throw new BadRequestException('PDF_FILE_REQUIRED');
    }
    if (material.type === TrainingMaterialType.MANUAL_TEXT) {
      return this.addRevision(material, actorId, this.extraction.extractManual(input.text ?? ''));
    }
    if (material.type === TrainingMaterialType.OBJECT_SNAPSHOT) {
      const extraction = await this.extractObjectSnapshot(material.projectId, input.fieldCodes ?? []);
      return this.addRevision(material, actorId, extraction);
    }

    try {
      const extracted = await this.urlExtractor.extract(material.sourceUrl ?? '');
      return this.addRevision(material, actorId, extracted, {
        requestedUrl: material.sourceUrl,
        finalUrl: extracted.finalUrl,
        fetchedAt: extracted.fetchedAt,
      });
    } catch (error) {
      return this.addFailedRevision(
        material,
        actorId,
        safeErrorCode(error, 'URL_EXTRACTION_FAILED'),
        { requestedUrl: material.sourceUrl },
      );
    }
  }

  async refreshPdf(materialId: string, actorId: string, file: UploadedFile | undefined) {
    const material = await this.findMaterial(materialId);
    await this.requireEditableProject(material.projectId);
    if (material.type !== TrainingMaterialType.PDF || material.status !== TrainingMaterialStatus.ACTIVE) {
      throw new ConflictException('MATERIAL_PDF_REFRESH_NOT_ALLOWED');
    }
    const validated = validatePdf(file);
    try {
      const extraction = await this.extraction.extractPdf(validated.buffer);
      return this.addPdfRevision(material, actorId, validated, extraction);
    } catch (error) {
      return this.addPdfRevision(
        material,
        actorId,
        validated,
        null,
        safeErrorCode(error, 'PDF_EXTRACTION_FAILED'),
      );
    }
  }

  async archive(materialId: string) {
    const material = await this.findMaterial(materialId);
    await this.requireEditableProject(material.projectId);
    if (material.status === TrainingMaterialStatus.ARCHIVED) return serializeMaterialDetail(material);
    await this.prisma.trainingMaterial.update({
      where: { id: material.id },
      data: { status: TrainingMaterialStatus.ARCHIVED },
    });
    return this.get(material.id);
  }

  async generateSuggestions(revisionId: string) {
    const revision = await this.findRevision(revisionId);
    await this.requireEditableProject(revision.material.projectId);
    if (revision.status !== TrainingMaterialRevisionStatus.READY ||
      revision.material.status !== TrainingMaterialStatus.ACTIVE) {
      throw new ConflictException('MATERIAL_REVISION_NOT_READY');
    }
    const questions = await this.prisma.trainingQuestion.findMany({
      where: { projectId: revision.material.projectId, isActive: true },
      select: { id: true, text: true },
      orderBy: [{ type: 'asc' }, { position: 'asc' }],
    });
    if (!questions.length) {
      throw new ConflictException('PROJECT_QUESTIONS_REQUIRED_FOR_SUGGESTIONS');
    }
    const segments = parseStoredSegments(revision.segmentsJson);
    try {
      const result = await this.suggester.suggest({
        projectId: revision.material.projectId,
        revisionId: revision.id,
        questions,
        segments,
      });
      validateMaterialSuggestions(result.suggestions, {
        projectId: revision.material.projectId,
        revisionId: revision.id,
        questions,
        segments,
      });
      await this.prisma.trainingMaterialRevision.update({
        where: { id: revision.id },
        data: {
          suggestionStatus: TrainingMaterialSuggestionStatus.READY,
          suggestionsJson: result.suggestions as unknown as Prisma.InputJsonValue,
          suggestionModel: result.model,
          suggestionRequestIdsJson: {
            ids: result.requestIds,
            attempts: result.attempts,
            chunkCount: result.chunkCount,
            sourceChars: result.sourceChars,
            generatedAt: result.generatedAt.toISOString(),
          } as Prisma.InputJsonValue,
          suggestionErrorCode: null,
        },
      });
    } catch (error) {
      const code = safeErrorCode(error, 'SUGGESTION_FAILED');
      await this.prisma.trainingMaterialRevision.update({
        where: { id: revision.id },
        data: {
          suggestionStatus: TrainingMaterialSuggestionStatus.FAILED,
          suggestionsJson: Prisma.DbNull,
          suggestionModel: null,
          suggestionRequestIdsJson: {
            ids: [],
            attempts: 0,
            generatedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
          suggestionErrorCode: code,
        },
      });
      throw error;
    }
    return this.get(revision.material.id);
  }

  async applySuggestions(
    revisionId: string,
    input: ApplyTrainingMaterialSuggestionsRequest,
  ) {
    if (!input.suggestions.length) throw new BadRequestException('SUGGESTIONS_REQUIRED');
    const revision = await this.findRevision(revisionId);
    await this.requireEditableProject(revision.material.projectId);
    if (revision.status !== TrainingMaterialRevisionStatus.READY ||
      revision.suggestionStatus !== TrainingMaterialSuggestionStatus.READY ||
      revision.material.status !== TrainingMaterialStatus.ACTIVE) {
      throw new ConflictException('MATERIAL_SUGGESTIONS_NOT_READY');
    }
    const stored = parseSuggestionsJson(revision.suggestionsJson);
    const storedById = new Map(stored.map((suggestion) => [suggestion.id, suggestion]));
    const segments = parseStoredSegments(revision.segmentsJson);
    const questionIds = new Set((await this.prisma.trainingQuestion.findMany({
      where: { projectId: revision.material.projectId, isActive: true }, select: { id: true },
    })).map((question) => question.id));

    const selected = input.suggestions.map((suggestion) => {
      const original = storedById.get(suggestion.suggestionId);
      if (!original || !questionIds.has(suggestion.targetQuestionId) ||
        suggestion.sourceLocator !== original.sourceLocator ||
        suggestion.sourceExcerpt !== original.sourceExcerpt ||
        !isExactSegmentExcerpt(segments, suggestion.sourceLocator, suggestion.sourceExcerpt)) {
        throw new BadRequestException('SUGGESTION_INVALID');
      }
      return {
        ...suggestion,
        statement: normalizeTrainingMaterialText(suggestion.statement),
        aliases: suggestion.aliases.map(normalizeTrainingMaterialText),
      };
    });
    if (selected.some((suggestion) => !suggestion.statement || suggestion.statement.length > 1_000 ||
      suggestion.aliases.length > 20 || suggestion.aliases.some((alias) => !alias || alias.length > 80))) {
      throw new BadRequestException('SUGGESTION_INVALID');
    }

    return this.prisma.$transaction(async (transaction) => {
      await lockProject(transaction, revision.material.projectId);
      const existing = await transaction.trainingFact.findMany({
        where: { question: { projectId: revision.material.projectId }, isActive: true },
        select: { statement: true },
      });
      const canonicalExisting = existing.map((fact) => canonicalTrainingFact(fact.statement));
      const duplicates: Array<{ suggestionId: string; reason: string }> = [];
      const created: string[] = [];
      const nextPositionByQuestion = new Map<string, number>();

      for (const suggestion of selected) {
        const canonical = canonicalTrainingFact(suggestion.statement);
        const duplicate = canonicalExisting.some((current) => isCanonicalDuplicate(current, canonical));
        if (duplicate) {
          duplicates.push({ suggestionId: suggestion.suggestionId, reason: 'DUPLICATE_FACT' });
          continue;
        }
        let position = nextPositionByQuestion.get(suggestion.targetQuestionId);
        if (position === undefined) {
          const aggregate = await transaction.trainingFact.aggregate({
            where: { questionId: suggestion.targetQuestionId }, _max: { position: true },
          });
          position = (aggregate._max.position ?? 0) + 1;
        }
        const fact = await transaction.trainingFact.create({
          data: {
            questionId: suggestion.targetQuestionId,
            statement: suggestion.statement,
            aliasesJson: suggestion.aliases as Prisma.InputJsonValue,
            isRequired: suggestion.isRequired,
            position,
            isActive: true,
            sourceType: TrainingFactSourceType.MATERIAL,
            sourceRevisionId: revision.id,
            sourceLabel: revision.material.title,
            sourceLocator: suggestion.sourceLocator,
            sourceExcerpt: suggestion.sourceExcerpt,
          },
          select: { id: true },
        });
        created.push(fact.id);
        canonicalExisting.push(canonical);
        nextPositionByQuestion.set(suggestion.targetQuestionId, position + 1);
      }
      return { createdFactIds: created, duplicates };
    });
  }

  async downloadPdf(materialId: string) {
    const material = await this.findMaterial(materialId);
    if (material.type !== TrainingMaterialType.PDF) throw new NotFoundException('MATERIAL_PDF_NOT_FOUND');
    const revision = material.revisions.find((item) => item.fileId);
    if (!revision?.fileId) throw new NotFoundException('MATERIAL_PDF_NOT_FOUND');
    const file = await this.prisma.file.findUnique({ where: { id: revision.fileId } });
    if (!file || file.url !== null || file.bucket !== materialBucket()) {
      throw new NotFoundException('MATERIAL_PDF_NOT_FOUND');
    }
    return { file, buffer: await this.storage.getObject(file.key, file.bucket ?? undefined) };
  }

  private async createMaterialWithRevision(input: {
    projectId: string;
    actorId: string;
    title: string;
    type: TrainingMaterialType;
    extraction: TrainingMaterialExtraction;
    sourceUrl?: string;
    requestedUrl?: string;
    finalUrl?: string;
    fetchedAt?: Date;
    officialConfirmedAt?: Date;
    officialConfirmedById?: string;
  }) {
    const title = requiredTitle(input.title);
    const material = await this.prisma.trainingMaterial.create({
      data: {
        projectId: input.projectId,
        createdById: input.actorId,
        title,
        type: input.type,
        sourceUrl: input.sourceUrl,
        officialConfirmedAt: input.officialConfirmedAt,
        officialConfirmedById: input.officialConfirmedById,
        revisions: { create: revisionCreateData({
          actorId: input.actorId,
          revisionNumber: 1,
          previousRevision: null,
          extraction: input.extraction,
          requestedUrl: input.requestedUrl,
          finalUrl: input.finalUrl,
          fetchedAt: input.fetchedAt,
        }) },
      },
      include: materialInclude,
    });
    return serializeMaterialDetail(material);
  }

  private async addRevision(
    material: MaterialRecord,
    actorId: string,
    extraction: TrainingMaterialExtraction,
    urlFields: { requestedUrl?: string | null; finalUrl?: string; fetchedAt?: Date } = {},
  ) {
    await this.prisma.$transaction(async (transaction) => {
      await lockMaterial(transaction, material.id);
      const previous = await transaction.trainingMaterialRevision.findFirst({
        where: { materialId: material.id }, orderBy: { revisionNumber: 'desc' },
      });
      await transaction.trainingMaterialRevision.create({ data: {
        materialId: material.id,
        ...revisionCreateData({
          actorId,
          revisionNumber: (previous?.revisionNumber ?? 0) + 1,
          previousRevision: previous,
          extraction,
          ...urlFields,
        }),
      } });
    });
    return this.get(material.id);
  }

  private async addFailedRevision(
    material: MaterialRecord,
    actorId: string,
    errorCode: string,
    urlFields: { requestedUrl?: string | null; finalUrl?: string; fetchedAt?: Date } = {},
    metadata: Record<string, unknown> = {},
  ) {
    await this.prisma.$transaction(async (transaction) => {
      await lockMaterial(transaction, material.id);
      const previous = await transaction.trainingMaterialRevision.findFirst({
        where: { materialId: material.id }, orderBy: { revisionNumber: 'desc' },
      });
      await transaction.trainingMaterialRevision.create({ data: {
        materialId: material.id,
        ...failedRevisionCreateData({
          actorId,
          revisionNumber: (previous?.revisionNumber ?? 0) + 1,
          previousRevision: previous,
          errorCode,
          method: material.type,
          metadata,
          ...urlFields,
        }),
      } });
    });
    return this.get(material.id);
  }

  private async createPdfMaterial(
    projectId: string,
    actorId: string,
    title: string,
    file: ValidatedPdf,
    extraction: TrainingMaterialExtraction | null,
    errorCode?: string,
    failureMetadata: Record<string, unknown> = {},
  ) {
    const materialId = randomUUID();
    const revisionId = randomUUID();
    const stored = await this.storePrivatePdf(materialId, revisionId, actorId, file);
    try {
      await this.prisma.trainingMaterial.create({
        data: {
          id: materialId, projectId, createdById: actorId, title,
          type: TrainingMaterialType.PDF,
          revisions: { create: {
            id: revisionId,
            fileId: stored.id,
            ...(extraction
              ? revisionCreateData({ actorId, revisionNumber: 1, previousRevision: null, extraction })
              : failedRevisionCreateData({
                  actorId,
                  revisionNumber: 1,
                  previousRevision: null,
                  errorCode: errorCode ?? 'PDF_EXTRACTION_FAILED',
                  method: 'PDF',
                  metadata: failureMetadata,
                })),
          } },
        },
      });
    } catch (error) {
      return this.cleanupPdfAfterFailedLink(projectId, stored, error);
    }
    return this.get(materialId);
  }

  private async addPdfRevision(
    material: MaterialRecord,
    actorId: string,
    file: ValidatedPdf,
    extraction: TrainingMaterialExtraction | null,
    errorCode?: string,
    failureMetadata: Record<string, unknown> = {},
  ) {
    const revisionId = randomUUID();
    const stored = await this.storePrivatePdf(material.id, revisionId, actorId, file);
    try {
      await this.prisma.$transaction(async (transaction) => {
        await lockMaterial(transaction, material.id);
        const previous = await transaction.trainingMaterialRevision.findFirst({
          where: { materialId: material.id }, orderBy: { revisionNumber: 'desc' },
        });
        await transaction.trainingMaterialRevision.create({ data: {
          id: revisionId, materialId: material.id, fileId: stored.id,
          ...(extraction
            ? revisionCreateData({
                actorId, revisionNumber: (previous?.revisionNumber ?? 0) + 1,
                previousRevision: previous, extraction,
              })
            : failedRevisionCreateData({
                actorId,
                revisionNumber: (previous?.revisionNumber ?? 0) + 1,
                previousRevision: previous,
                errorCode: errorCode ?? 'PDF_EXTRACTION_FAILED',
                method: 'PDF',
                metadata: failureMetadata,
              })),
        } });
      });
    } catch (error) {
      return this.cleanupPdfAfterFailedLink(material.projectId, stored, error);
    }
    return this.get(material.id);
  }

  private async cleanupPdfAfterFailedLink(
    projectId: string,
    stored: { id: string; key: string; bucket: string | null },
    originalError: unknown,
  ): Promise<never> {
    try {
      await this.storage.deleteObject(stored.key, stored.bucket ?? undefined);
    } catch (cleanupError) {
      try {
        await recordTrainingProjectDeleteCleanupObject(this.prisma, projectId, {
          key: stored.key,
          bucket: stored.bucket,
          fileId: stored.id,
        });
      } catch (auditError) {
        throw new AggregateError(
          [originalError, cleanupError, auditError],
          'Training PDF link and cleanup failed',
        );
      }

      throw new AggregateError(
        [originalError, cleanupError],
        'Training PDF link failed and storage cleanup is pending',
      );
    }

    try {
      await this.prisma.file.delete({ where: { id: stored.id } });
    } catch (cleanupError) {
      throw new AggregateError(
        [originalError, cleanupError],
        'Training PDF link failed and file cleanup is pending',
      );
    }

    throw originalError;
  }

  private async storePrivatePdf(
    materialId: string,
    revisionId: string,
    actorId: string,
    file: ValidatedPdf,
  ) {
    const bucket = materialBucket();
    const key = `training-v2/materials/${materialId}/${revisionId}.pdf`;
    await this.storage.putObject({ key, bucket, body: file.buffer, contentType: 'application/pdf' });
    try {
      return await this.prisma.file.create({ data: {
        storage: FileStorage.MINIO,
        bucket,
        key,
        url: null,
        originalName: file.originalname,
        mimeType: 'application/pdf',
        sizeBytes: BigInt(file.buffer.length),
        checksum: createHash('sha256').update(file.buffer).digest('hex'),
        uploadedById: actorId,
      } });
    } catch (error) {
      await this.storage.deleteObject(key, bucket).catch(() => undefined);
      throw error;
    }
  }

  private findObjectImportMaterials(projectId: string): Promise<MaterialRecord[]> {
    return this.prisma.trainingMaterial.findMany({
      where: {
        projectId,
        type: { in: [TrainingMaterialType.PDF, TrainingMaterialType.OBJECT_SNAPSHOT] },
      },
      include: materialInclude,
      orderBy: { createdAt: 'asc' },
    });
  }

  private async recordObjectPdfReadFailure(
    projectId: string,
    actorId: string,
    title: string,
    objectId: string,
    objectTitle: string,
    sourceObjectFileId: string,
    sourceFileId: string,
    existing: MaterialRecord | undefined,
    errorCode: string,
  ) {
    const metadata = {
      importKind: PLATFORM_OBJECT_IMPORT_KIND,
      objectId,
      objectTitle,
      sourceObjectFileId,
      sourceFileId,
    };
    if (existing) {
      await this.addFailedRevision(existing, actorId, errorCode, {}, metadata);
      return;
    }
    await this.prisma.trainingMaterial.create({
      data: {
        projectId,
        createdById: actorId,
        title,
        type: TrainingMaterialType.PDF,
        revisions: {
          create: failedRevisionCreateData({
            actorId,
            revisionNumber: 1,
            previousRevision: null,
            errorCode,
            method: 'PDF',
            metadata,
          }),
        },
      },
    });
  }

  private async applyGeneratedQuestionDrafts(
    projectId: string,
    objectId: string | null,
    generated: TrainingQuestionDraftGenerationResult,
    sources: TrainingQuestionDraftSource[],
    replaceExistingQuestions: boolean,
  ) {
    await this.prisma.$transaction(async (transaction) => {
      await lockProject(transaction, projectId);
      await this.assertQuestionReplacementAllowed(transaction, projectId, replaceExistingQuestions);
      await this.upsertGeneratedQuestionDrafts(transaction, projectId, objectId, generated, sources);
    });
  }

  private async requireQuestionReplacementConfirmation(
    projectId: string,
    replaceExistingQuestions: boolean,
  ) {
    const existingQuestions = await this.prisma.trainingQuestion.count({
      where: { projectId, isActive: true },
    });
    if (existingQuestions > 0 && !replaceExistingQuestions) {
      throw new ConflictException('PROJECT_QUESTIONS_REPLACE_CONFIRMATION_REQUIRED');
    }
  }

  private async assertQuestionReplacementAllowed(
    transaction: Prisma.TransactionClient,
    projectId: string,
    replaceExistingQuestions: boolean,
  ) {
    const existingQuestions = await transaction.trainingQuestion.count({
      where: { projectId, isActive: true },
    });
    if (existingQuestions > 0 && !replaceExistingQuestions) {
      throw new ConflictException('PROJECT_QUESTIONS_REPLACE_CONFIRMATION_REQUIRED');
    }
  }

  private generateQuestionDraftsForSource(input: {
    projectId: string;
    materialId: string;
    revisionId: string;
    title: string;
    type: TrainingQuestionDraftSource['materialType'];
    extraction: TrainingMaterialExtraction;
  }) {
    const sources: TrainingQuestionDraftSource[] = [{
      materialId: input.materialId,
      revisionId: input.revisionId,
      materialTitle: input.title,
      materialType: input.type,
      segments: input.extraction.segments,
    }];
    return this.suggester.generateQuestionDrafts({
      projectId: input.projectId,
      objectId: input.materialId,
      objectTitle: input.title,
      sources,
    }).then((generated) => ({ generated, sources }));
  }

  private async upsertGeneratedQuestionDrafts(
    transaction: Prisma.TransactionClient,
    projectId: string,
    objectId: string | null,
    generated: TrainingQuestionDraftGenerationResult,
    sources: TrainingQuestionDraftSource[],
  ) {
    if (generated.followUps.length !== 10) {
      throw new BadRequestException('OBJECT_QUESTION_DRAFTS_INVALID');
    }
    const project = await transaction.trainingProject.findUnique({
      where: { id: projectId },
      select: { id: true, isOpen: true },
    });
    if (!project) throw new NotFoundException('Training project not found');
    if (project.isOpen) throw new ConflictException('Close the training project before editing materials');

    await transaction.trainingProject.update({
      where: { id: projectId },
      data: {
        ...(objectId ? { realEstateObjectId: objectId } : {}),
        status: TrainingProjectStatus.DRAFT,
      },
    });
    const mainQuestion = await transaction.trainingQuestion.upsert({
      where: {
        projectId_type_position: {
          projectId,
          type: TrainingQuestionType.MAIN,
          position: 1,
        },
      },
      update: { text: generated.main.text, isActive: true },
      create: {
        projectId,
        type: TrainingQuestionType.MAIN,
        position: 1,
        text: generated.main.text,
        isActive: true,
      },
      select: { id: true },
    });
    const generatedQuestions = [{ questionId: mainQuestion.id, draft: generated.main }];
    for (const [index, question] of generated.followUps.entries()) {
      const persisted = await transaction.trainingQuestion.upsert({
        where: {
          projectId_type_position: {
            projectId,
            type: TrainingQuestionType.FOLLOW_UP,
            position: index + 1,
          },
        },
        update: { text: question.text, isActive: true },
        create: {
          projectId,
          type: TrainingQuestionType.FOLLOW_UP,
          position: index + 1,
          text: question.text,
          isActive: true,
        },
        select: { id: true },
      });
      generatedQuestions.push({ questionId: persisted.id, draft: question });
    }

    const sourceByCompositeLocator = generatedFactSourceMap(sources);
    await transaction.trainingFact.deleteMany({
      where: { question: { projectId } },
    });
    await transaction.trainingFact.createMany({
      data: generatedQuestions.flatMap(({ questionId, draft }) =>
        draft.facts.map((fact, index) => {
          const source = sourceByCompositeLocator.get(fact.sourceLocator);
          if (!source) throw new BadRequestException('OBJECT_QUESTION_DRAFTS_INVALID');
          return {
            questionId,
            statement: fact.statement,
            aliasesJson: fact.aliases as Prisma.InputJsonValue,
            isRequired: fact.isRequired,
            position: index + 1,
            isActive: true,
            sourceType: TrainingFactSourceType.MATERIAL,
            sourceRevisionId: source.sourceRevisionId,
            sourceLabel: source.sourceLabel,
            sourceLocator: source.sourceLocator,
            sourceExcerpt: fact.sourceExcerpt,
          };
        }),
      ),
    });
  }

  private async extractObjectSnapshot(projectId: string, rawCodes: string[]) {
    const fieldCodes = parseObjectFieldCodes(rawCodes);
    const project = await this.prisma.trainingProject.findUnique({
      where: { id: projectId },
      select: { realEstateObjectId: true },
    });
    if (!project?.realEstateObjectId) throw new BadRequestException('PROJECT_OBJECT_REQUIRED');
    const object = await this.prisma.realEstateObject.findFirst({
      where: { id: project.realEstateObjectId, deletedAt: null },
      select: {
        id: true, title: true, type: true, description: true, architectureDescription: true,
        infrastructureDescription: true, fillingDescription: true, krtName: true,
        apartmentAreaRange: true, ceilingHeight: true, propertyClass: true,
        floorRange: true, completionYear: true, completionQuarter: true, address: true,
        developer: { select: { name: true } },
        locations: { select: { location: { select: { name: true, type: true } } }, orderBy: { sortOrder: 'asc' } },
        metroStations: { select: { metroStation: { select: { name: true, lineName: true } } }, orderBy: { sortOrder: 'asc' } },
      },
    });
    if (!object) throw new BadRequestException('PROJECT_OBJECT_REQUIRED');
    return this.extractObjectSnapshotRecord(object, fieldCodes);
  }

  private extractObjectSnapshotRecord(object: ObjectSnapshotRecord, fieldCodes: ObjectFieldCode[]) {
    const values: Record<ObjectFieldCode, string | null> = {
      title: object.title,
      type: object.type,
      description: object.description,
      architectureDescription: object.architectureDescription,
      infrastructureDescription: object.infrastructureDescription,
      fillingDescription: object.fillingDescription,
      krtName: object.krtName,
      apartmentAreaRange: object.apartmentAreaRange,
      ceilingHeight: object.ceilingHeight,
      propertyClass: object.propertyClass,
      floorRange: object.floorRange,
      completion: object.completionYear
        ? `${object.completionQuarter ? `${object.completionQuarter} кв. ` : ''}${object.completionYear}`
        : null,
      address: object.address,
      developer: object.developer?.name ?? null,
      locations: object.locations.map((item) => item.location.name).join(', ') || null,
      metroStations: object.metroStations.map((item) =>
        item.metroStation.lineName
          ? `${item.metroStation.name} (${item.metroStation.lineName})`
          : item.metroStation.name,
      ).join(', ') || null,
    };
    const fieldValues = Object.fromEntries(fieldCodes.map((code) => [
      code,
      normalizeTrainingMaterialText(values[code] ?? ''),
    ]));
    const segments = fieldCodes.flatMap((code) => {
      const value = fieldValues[code] ?? '';
      return value ? [{ locator: `object-field:${code}`, label: OBJECT_FIELD_LABELS[code], text: value }] : [];
    });
    return this.extraction.complete(segments, {
      method: 'OBJECT_SNAPSHOT',
      objectId: object.id,
      objectTitle: object.title,
      fieldCodes,
      fieldValues,
    });
  }

  private async requireProject(projectId: string) {
    const project = await this.prisma.trainingProject.findUnique({ where: { id: projectId }, select: { id: true } });
    if (!project) throw new NotFoundException('Training project not found');
    return project;
  }

  private async requireEditableProject(projectId: string) {
    const project = await this.prisma.trainingProject.findUnique({ where: { id: projectId }, select: { id: true, isOpen: true } });
    if (!project) throw new NotFoundException('Training project not found');
    if (project.isOpen) throw new ConflictException('Close the training project before editing materials');
    return project;
  }

  private async findMaterial(materialId: string): Promise<MaterialRecord> {
    const material = await this.prisma.trainingMaterial.findUnique({ where: { id: materialId }, include: materialInclude });
    if (!material) throw new NotFoundException('Training material not found');
    return material;
  }

  private async findRevision(revisionId: string) {
    const revision = await this.prisma.trainingMaterialRevision.findUnique({
      where: { id: revisionId }, include: { material: true },
    });
    if (!revision) throw new NotFoundException('Training material revision not found');
    return revision;
  }
}

type ValidatedPdf = { originalname: string; buffer: Buffer };

function validatePdf(file: UploadedFile | undefined): ValidatedPdf {
  const maxBytes = readPdfMaxBytes();
  if (!file?.buffer || file.buffer.length === 0) throw new BadRequestException('PDF_FILE_REQUIRED');
  if (file.mimetype.toLowerCase() !== 'application/pdf' || !file.originalname.toLowerCase().endsWith('.pdf')) {
    throw new BadRequestException('PDF_TYPE_INVALID');
  }
  if (file.buffer.length > maxBytes || file.size > maxBytes) throw new BadRequestException('PDF_SIZE_EXCEEDED');
  if (!file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new BadRequestException('PDF_MAGIC_INVALID');
  return { originalname: file.originalname.slice(0, 255), buffer: file.buffer };
}

function readPdfMaxBytes() {
  const value = Number(process.env.TRAINING_MATERIAL_MAX_BYTES ?? DEFAULT_PDF_MAX_BYTES);
  return Number.isInteger(value) && value >= 1024 && value <= 100 * 1024 * 1024
    ? value
    : DEFAULT_PDF_MAX_BYTES;
}

function materialBucket() {
  return process.env.TRAINING_MATERIAL_BUCKET?.trim() || 'training-materials';
}

function requiredTitle(value: string) {
  const title = normalizeTrainingMaterialText(value);
  if (!title || title.length > 240) throw new BadRequestException('MATERIAL_TITLE_INVALID');
  return title;
}

function serializeObjectOption(object: {
  id: string;
  title: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  developer: { name: string } | null;
  files: Array<{
    id: string;
    file: { mimeType: string | null; originalName: string | null };
  }>;
}) {
  return {
    id: object.id,
    title: object.title,
    status: object.status,
    developerName: object.developer?.name ?? null,
    pdfCount: object.files.filter(isPdfObjectFile).length,
  };
}

function latestRevisionMetadata(material: MaterialRecord) {
  const latest = material.revisions[0];
  return latest && isRecord(latest.extractionMetadataJson)
    ? latest.extractionMetadataJson
    : null;
}

function questionSourceFromMaterial(material: TrainingMaterialDetail): TrainingQuestionDraftSource {
  const revision = material.latestRevision;
  if (!revision || revision.status !== TrainingMaterialRevisionStatus.READY ||
    (material.type !== TrainingMaterialType.PDF &&
      material.type !== TrainingMaterialType.OFFICIAL_URL &&
      material.type !== TrainingMaterialType.OBJECT_SNAPSHOT)) {
    throw new BadRequestException('OBJECT_QUESTION_SOURCE_INVALID');
  }
  return {
    materialId: material.id,
    revisionId: revision.id,
    materialTitle: material.title,
    materialType: material.type,
    segments: revision.segments,
  };
}

function generatedFactSourceMap(sources: readonly TrainingQuestionDraftSource[]) {
  const result = new Map<string, {
    sourceRevisionId: string;
    sourceLabel: string;
    sourceLocator: string;
  }>();
  for (const source of sources) {
    for (const segment of source.segments) {
      const compositeLocator = `${source.revisionId}:${segment.locator}`;
      if (result.has(compositeLocator)) {
        throw new BadRequestException('OBJECT_QUESTION_DRAFTS_INVALID');
      }
      result.set(compositeLocator, {
        sourceRevisionId: source.revisionId,
        sourceLabel: source.materialTitle,
        sourceLocator: segment.locator,
      });
    }
  }
  return result;
}

function isPdfObjectFile(objectFile: {
  file: { mimeType: string | null; originalName: string | null };
}) {
  return objectFile.file.mimeType?.toLocaleLowerCase('en-US') === 'application/pdf' ||
    objectFile.file.originalName?.toLocaleLowerCase('en-US').endsWith('.pdf') === true;
}

function parseObjectFieldCodes(value: string[]): ObjectFieldCode[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > OBJECT_FIELD_CODES.length) {
    throw new BadRequestException('OBJECT_FIELD_CODES_INVALID');
  }
  const allowed = new Set<string>(OBJECT_FIELD_CODES);
  const unique = [...new Set(value)];
  if (unique.some((code) => typeof code !== 'string' || !allowed.has(code))) {
    throw new BadRequestException('OBJECT_FIELD_CODES_INVALID');
  }
  return unique as ObjectFieldCode[];
}

function revisionCreateData(input: {
  actorId: string;
  revisionNumber: number;
  previousRevision: { id: string; segmentsJson: Prisma.JsonValue } | null;
  extraction: TrainingMaterialExtraction;
  requestedUrl?: string | null;
  finalUrl?: string;
  fetchedAt?: Date;
}) {
  const previousSegments = input.previousRevision ? parseStoredSegments(input.previousRevision.segmentsJson) : [];
  const diff = createTrainingMaterialDiff(input.previousRevision?.id ?? null, previousSegments, input.extraction.segments);
  return {
    revisionNumber: input.revisionNumber,
    previousRevisionId: input.previousRevision?.id ?? null,
    status: TrainingMaterialRevisionStatus.READY,
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    fetchedAt: input.fetchedAt,
    extractedText: input.extraction.text,
    segmentsJson: input.extraction.segments as unknown as Prisma.InputJsonValue,
    contentHash: input.extraction.contentHash,
    extractionMetadataJson: input.extraction.metadata as Prisma.InputJsonValue,
    diffJson: diff as unknown as Prisma.InputJsonValue,
    isChanged: diff.changed,
    createdById: input.actorId,
  };
}

function failedRevisionCreateData(input: {
  actorId: string;
  revisionNumber: number;
  previousRevision: { id: string; segmentsJson: Prisma.JsonValue } | null;
  errorCode: string;
  method: string;
  metadata?: Record<string, unknown>;
  requestedUrl?: string | null;
  finalUrl?: string;
  fetchedAt?: Date;
}) {
  const previousSegments = input.previousRevision ? parseStoredSegments(input.previousRevision.segmentsJson) : [];
  const diff = createTrainingMaterialDiff(input.previousRevision?.id ?? null, previousSegments, []);
  return {
    revisionNumber: input.revisionNumber,
    previousRevisionId: input.previousRevision?.id ?? null,
    status: TrainingMaterialRevisionStatus.FAILED,
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    fetchedAt: input.fetchedAt,
    extractedText: '',
    segmentsJson: [] as Prisma.InputJsonValue,
    contentHash: createHash('sha256').update('').digest('hex'),
    extractionMetadataJson: {
      method: input.method,
      errorCode: input.errorCode,
      ...input.metadata,
    } as Prisma.InputJsonValue,
    diffJson: diff as unknown as Prisma.InputJsonValue,
    isChanged: diff.changed,
    createdById: input.actorId,
  };
}

function serializeMaterial(material: Prisma.TrainingMaterialGetPayload<{ include: { revisions: true } }>) {
  const latest = [...material.revisions].sort((left, right) => right.revisionNumber - left.revisionNumber)[0];
  return {
    id: material.id,
    projectId: material.projectId,
    type: material.type,
    title: material.title,
    status: material.status,
    sourceUrl: material.sourceUrl,
    officialConfirmedAt: material.officialConfirmedAt?.toISOString() ?? null,
    latestRevision: latest ? serializeRevision(latest) : null,
    createdAt: material.createdAt.toISOString(),
    updatedAt: material.updatedAt.toISOString(),
  };
}

function serializeMaterialDetail(material: MaterialRecord): TrainingMaterialDetail {
  return {
    ...serializeMaterial(material),
    revisions: material.revisions.map(serializeRevision),
  };
}

function serializeRevision(revision: Prisma.TrainingMaterialRevisionGetPayload<Record<string, never>>): TrainingMaterialRevisionContract {
  return {
    id: revision.id,
    revisionNumber: revision.revisionNumber,
    previousRevisionId: revision.previousRevisionId,
    status: revision.status,
    requestedUrl: revision.requestedUrl,
    finalUrl: revision.finalUrl,
    fetchedAt: revision.fetchedAt?.toISOString() ?? null,
    extractedText: revision.extractedText,
    segments: parseStoredSegments(revision.segmentsJson),
    contentHash: revision.contentHash,
    extractionMetadata: isRecord(revision.extractionMetadataJson) ? revision.extractionMetadataJson : {},
    diff: parseDiff(revision.diffJson),
    isChanged: revision.isChanged,
    suggestionStatus: revision.suggestionStatus,
    suggestions: revision.suggestionsJson === null ? null : parseSuggestionsJson(revision.suggestionsJson),
    suggestionModel: revision.suggestionModel,
    suggestionErrorCode: revision.suggestionErrorCode,
    createdAt: revision.createdAt.toISOString(),
  };
}

function parseSuggestionsJson(value: unknown) {
  if (!Array.isArray(value)) throw new BadRequestException('MATERIAL_SUGGESTIONS_INVALID');
  return value.map((suggestion) => {
    if (!isRecord(suggestion) || typeof suggestion.id !== 'string' ||
      typeof suggestion.targetQuestionId !== 'string' || typeof suggestion.statement !== 'string' ||
      !Array.isArray(suggestion.aliases) || suggestion.aliases.some((alias) => typeof alias !== 'string') ||
      typeof suggestion.isRequired !== 'boolean' || typeof suggestion.sourceLocator !== 'string' ||
      typeof suggestion.sourceExcerpt !== 'string') {
      throw new BadRequestException('MATERIAL_SUGGESTIONS_INVALID');
    }
    return {
      id: suggestion.id,
      targetQuestionId: suggestion.targetQuestionId,
      statement: suggestion.statement,
      aliases: suggestion.aliases as string[],
      isRequired: suggestion.isRequired,
      sourceLocator: suggestion.sourceLocator,
      sourceExcerpt: suggestion.sourceExcerpt,
    };
  });
}

function parseDiff(value: unknown) {
  if (!isRecord(value) ||
    (value.previousRevisionId !== null && typeof value.previousRevisionId !== 'string') ||
    !Array.isArray(value.added) || value.added.some((item) => typeof item !== 'string') ||
    !Array.isArray(value.removed) || value.removed.some((item) => typeof item !== 'string') ||
    !Number.isInteger(value.unchangedCount) || (value.unchangedCount as number) < 0 ||
    typeof value.changed !== 'boolean') {
    throw new BadRequestException('MATERIAL_DIFF_INVALID');
  }
  return {
    previousRevisionId: value.previousRevisionId,
    added: value.added as string[],
    removed: value.removed as string[],
    unchangedCount: value.unchangedCount as number,
    changed: value.changed,
  };
}

function isCanonicalDuplicate(existing: string, next: string) {
  return existing === next ||
    (Math.min(existing.length, next.length) >= 30 && (existing.includes(next) || next.includes(existing)));
}

async function lockProject(transaction: Prisma.TransactionClient, projectId: string) {
  await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "training_projects" WHERE "id" = CAST(${projectId} AS uuid) FOR UPDATE`);
}

async function lockMaterial(transaction: Prisma.TransactionClient, materialId: string) {
  await transaction.$queryRaw(Prisma.sql`SELECT "id" FROM "training_materials" WHERE "id" = CAST(${materialId} AS uuid) FOR UPDATE`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeErrorCode(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_]{2,119}$/u.test(message) ? message : fallback;
}
