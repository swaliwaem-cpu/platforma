import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ObjectStatus,
  Prisma,
  ProjectPresentationDocumentStatus,
  RealEstateObjectType,
} from '@prisma/client';

import { AuthenticatedUser } from '../auth/auth.types';
import { FilesService } from '../files/files.service';
import { UploadedFile } from '../files/uploaded-file.type';
import { PrismaService } from '../prisma/prisma.service';
import { createSearchContainsFilters } from '../search/search-filters';
import {
  PROJECT_PRESENTATION_MAX_ADVANTAGES,
  PROJECT_PRESENTATION_MAX_IMAGES,
  PROJECT_PRESENTATION_MAX_OBJECTS,
  PROJECT_PRESENTATION_PAGE_HEIGHT,
  PROJECT_PRESENTATION_PAGE_WIDTH,
  PROJECT_PRESENTATION_SNAPSHOT_VERSION,
  PROJECT_PRESENTATION_TEMPLATE_VERSION,
  ProjectPresentationSnapshotImage,
  ProjectPresentationSnapshotV1,
} from './project-presentations.types';

const objectInclude = {
  developer: true,
  primaryLocation: true,
  metroStations: {
    include: { metroStation: true },
    orderBy: { sortOrder: 'asc' },
  },
  images: {
    include: { file: true },
    orderBy: [{ isCover: 'desc' }, { sortOrder: 'asc' }],
  },
} satisfies Prisma.RealEstateObjectInclude;

const draftInclude = {
  coverFile: true,
  owner: {
    select: {
      id: true,
      name: true,
      email: true,
      brokerPhone: true,
      brokerEmail: true,
      profilePhotoFile: { select: { id: true, checksum: true } },
    },
  },
  objects: {
    include: { object: { include: objectInclude } },
    orderBy: { sortOrder: 'asc' },
  },
} satisfies Prisma.ProjectPresentationDraftInclude;

type DraftRecord = Prisma.ProjectPresentationDraftGetPayload<{ include: typeof draftInclude }>;
type ObjectRecord = Prisma.RealEstateObjectGetPayload<{ include: typeof objectInclude }>;
type DraftObjectInput = {
  objectId: string;
  manualTitle: string | null;
  manualDescription: string | null;
  advantages: string[];
  imageIds: string[];
  propertyClass: string | null;
  completion: string | null;
  price: string | null;
  district: string | null;
  developer: string | null;
  metro: string | null;
};

@Injectable()
export class ProjectPresentationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly filesService: FilesService,
  ) {}

  async listCatalogObjects(query: Record<string, string | undefined>) {
    const page = this.parsePositiveInteger(query.page, 1);
    const limit = Math.min(this.parsePositiveInteger(query.limit, 24), 100);
    const search = query.search?.trim();
    const where: Prisma.RealEstateObjectWhereInput = {
      status: ObjectStatus.PUBLISHED,
      type: RealEstateObjectType.RESIDENTIAL,
      deletedAt: null,
      ...(search
        ? {
            OR: [
              ...createSearchContainsFilters(search, ['title', 'address', 'slug']),
              { developer: { name: { contains: search, mode: 'insensitive' as const } } },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.realEstateObject.findMany({
        where,
        include: objectInclude,
        orderBy: { title: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.realEstateObject.count({ where }),
    ]);

    return {
      items: items.map((object) => this.serializeCatalogObject(object)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async listDrafts() {
    const drafts = await this.prisma.projectPresentationDraft.findMany({
      include: draftInclude,
      orderBy: { updatedAt: 'desc' },
    });
    return { items: drafts.map((draft) => this.serializeDraft(draft)) };
  }

  async getDraft(id: string) {
    const draft = await this.findDraft(id);
    return { draft: this.serializeDraft(draft) };
  }

  async createDraft(body: Record<string, unknown>, actor: AuthenticatedUser) {
    const title = this.parseRequiredString(body.title, 'Draft title is required', 180);
    const draft = await this.prisma.projectPresentationDraft.create({
      data: {
        ownerUserId: actor.id,
        title,
        coverTitle: this.parseNullableString(body.coverTitle, 'Cover title', 180),
        coverSubtitle: this.parseNullableString(body.coverSubtitle, 'Cover subtitle', 500),
        clientName: this.parseNullableString(body.clientName, 'Client name', 180),
        issueLabel: this.parseNullableString(body.issueLabel, 'Issue label', 180),
        coverImageId: this.parseNullableUuid(body.coverImageId, 'Cover image is invalid'),
        templateVersion: PROJECT_PRESENTATION_TEMPLATE_VERSION,
      },
      include: draftInclude,
    });
    return { draft: this.serializeDraft(draft) };
  }

  async updateDraft(id: string, body: Record<string, unknown>) {
    const draftId = this.parseUuid(id, 'Draft is invalid');
    const version = this.parseVersion(body.version);
    const existing = await this.findDraft(id);
    const data: Prisma.ProjectPresentationDraftUncheckedUpdateManyInput = {};

    if ('title' in body) data.title = this.parseRequiredString(body.title, 'Draft title is required', 180);
    if ('coverTitle' in body) data.coverTitle = this.parseNullableString(body.coverTitle, 'Cover title', 180);
    if ('coverSubtitle' in body) data.coverSubtitle = this.parseNullableString(body.coverSubtitle, 'Cover subtitle', 500);
    if ('clientName' in body) data.clientName = this.parseNullableString(body.clientName, 'Client name', 180);
    if ('issueLabel' in body) data.issueLabel = this.parseNullableString(body.issueLabel, 'Issue label', 180);
    let previousCustomCoverFileId: string | null = null;
    if ('coverImageId' in body) {
      const coverImageId = this.parseNullableUuid(body.coverImageId, 'Cover image is invalid');
      if (coverImageId) this.ensureImageBelongsToDraft(existing, coverImageId);
      data.coverImageId = coverImageId;
      if (coverImageId && existing.coverFileId) {
        data.coverFileId = null;
        previousCustomCoverFileId = existing.coverFileId;
      }
    }
    data.version = { increment: 1 };

    const updated = await this.prisma.projectPresentationDraft.updateMany({
      where: { id: draftId, version },
      data,
    });
    if (updated.count !== 1) throw new ConflictException('Draft was changed by another user');
    const response = await this.getDraft(draftId);
    if (previousCustomCoverFileId) {
      await this.filesService.deleteUnlinkedFile(previousCustomCoverFileId);
    }
    return response;
  }

  async uploadDraftCover(
    id: string,
    versionValue: unknown,
    file: UploadedFile | undefined,
    actor: AuthenticatedUser,
  ) {
    const draftId = this.parseUuid(id, 'Draft is invalid');
    const version = this.parseVersion(versionValue);
    const existing = await this.findDraft(id);
    if (existing.version !== version) throw new ConflictException('Draft was changed by another user');
    const uploaded = await this.filesService.uploadFile(file, actor, 'image');

    try {
      const updated = await this.prisma.projectPresentationDraft.updateMany({
        where: { id: draftId, version },
        data: {
          coverFileId: uploaded.file.id,
          coverImageId: null,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw new ConflictException('Draft was changed by another user');
    } catch (error) {
      await this.filesService.deleteUnlinkedFile(uploaded.file.id);
      throw error;
    }

    if (existing.coverFileId && existing.coverFileId !== uploaded.file.id) {
      await this.filesService.deleteUnlinkedFile(existing.coverFileId);
    }
    return this.getDraft(draftId);
  }

  async replaceDraftObjects(id: string, body: Record<string, unknown>) {
    const draftId = this.parseUuid(id, 'Draft is invalid');
    const version = this.parseVersion(body.version);
    const inputs = this.parseDraftObjects(body.objects);
    const objectIds = inputs.map((item) => item.objectId);
    const objects = objectIds.length
      ? await this.prisma.realEstateObject.findMany({
          where: {
            id: { in: objectIds },
            status: ObjectStatus.PUBLISHED,
            type: RealEstateObjectType.RESIDENTIAL,
            deletedAt: null,
          },
          include: objectInclude,
        })
      : [];
    if (objects.length !== objectIds.length) throw new BadRequestException('One or more projects are unavailable');
    const objectsById = new Map(objects.map((object) => [object.id, object]));
    for (const input of inputs) {
      const object = objectsById.get(input.objectId);
      if (!object) throw new BadRequestException('Project is unavailable');
      const validImageIds = new Set(object.images.map((image) => image.id));
      if (input.imageIds.some((imageId) => !validImageIds.has(imageId))) {
        throw new BadRequestException('Selected image does not belong to the project');
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.projectPresentationDraft.updateMany({
        where: { id: draftId, version },
        data: { version: { increment: 1 } },
      });
      if (updated.count !== 1) throw new ConflictException('Draft was changed by another user');
      await tx.projectPresentationDraftObject.deleteMany({ where: { draftId } });
      for (const [sortOrder, input] of inputs.entries()) {
        await tx.projectPresentationDraftObject.create({
          data: {
            draftId,
            objectId: input.objectId,
            sortOrder,
            manualTitle: input.manualTitle,
            manualDescription: input.manualDescription,
            manualPropertyClass: input.propertyClass,
            manualCompletion: input.completion,
            manualPrice: input.price,
            manualDistrict: input.district,
            manualDeveloper: input.developer,
            manualMetro: input.metro,
            advantages: input.advantages,
            imageIds: input.imageIds,
          },
        });
      }
      const current = await tx.projectPresentationDraft.findUnique({ where: { id: draftId }, select: { coverImageId: true } });
      if (current?.coverImageId && !objects.some((object) => object.images.some((image) => image.id === current.coverImageId))) {
        await tx.projectPresentationDraft.update({ where: { id: draftId }, data: { coverImageId: null } });
      }
    });
    return this.getDraft(draftId);
  }

  async deleteDraft(id: string) {
    const draftId = this.parseUuid(id, 'Draft is invalid');
    let deleted: { coverFileId: string | null };
    try {
      deleted = await this.prisma.projectPresentationDraft.delete({
        where: { id: draftId },
        select: { coverFileId: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Draft not found');
      }
      throw error;
    }
    if (deleted.coverFileId) {
      await this.filesService.deleteUnlinkedFile(deleted.coverFileId);
    }
  }

  async createDocument(id: string, body: Record<string, unknown>, actor: AuthenticatedUser) {
    const draftId = this.parseUuid(id, 'Draft is invalid');
    const version = this.parseVersion(body.version);
    const idempotencyKey = this.parseNullableString(body.idempotencyKey, 'Idempotency key', 80);
    const requestedTitle = this.parseNullableString(body.title, 'Document title', 180);
    if (idempotencyKey) {
      const existing = await this.prisma.projectPresentationDocument.findUnique({
        where: { ownerUserId_idempotencyKey: { ownerUserId: actor.id, idempotencyKey } },
      });
      if (existing) return this.getDocument(existing.id);
    }

    const document = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "project_presentation_drafts" WHERE "id" = ${draftId}::uuid FOR SHARE`;
      const draft = await tx.projectPresentationDraft.findUnique({
        where: { id: draftId },
        include: draftInclude,
      });
      if (!draft) throw new NotFoundException('Draft not found');
      if (draft.version !== version) throw new ConflictException('Draft was changed by another user');
      if (draft.objects.length < 1 || draft.objects.length > PROJECT_PRESENTATION_MAX_OBJECTS) {
        throw new BadRequestException(`Select from 1 to ${PROJECT_PRESENTATION_MAX_OBJECTS} projects`);
      }
      if (draft.objects.some((item) => item.object.status !== ObjectStatus.PUBLISHED || item.object.type !== RealEstateObjectType.RESIDENTIAL || item.object.deletedAt)) {
        throw new BadRequestException('One or more projects are no longer available');
      }
      if (!draft.coverFile && !draft.coverImageId) throw new BadRequestException('Select a cover image before generation');
      if (!draft.coverFile && draft.coverImageId) this.ensureImageBelongsToDraft(draft, draft.coverImageId);
      const title = requestedTitle ?? draft.title;
      const snapshot = this.createSnapshot(draft, title);
      const assets = this.collectSnapshotAssets(snapshot, draft.coverFileId);

      return tx.projectPresentationDocument.create({
        data: {
          ownerUserId: actor.id,
          draftId: draft.id,
          title,
          templateVersion: draft.templateVersion,
          snapshotVersion: PROJECT_PRESENTATION_SNAPSHOT_VERSION,
          snapshotJson: snapshot as unknown as Prisma.InputJsonValue,
          objectsCount: snapshot.objects.length,
          idempotencyKey,
          objects: {
            create: snapshot.objects.map((object) => ({
              objectId: object.sourceObjectId,
              sourceObjectId: object.sourceObjectId,
              sortOrder: object.sortOrder,
            })),
          },
          assets: {
            create: assets.map((asset) => ({
              fileId: asset.fileId,
              sourceObjectId: asset.sourceObjectId,
              role: asset.role,
              sortOrder: asset.sortOrder,
            })),
          },
        },
      });
    });
    return this.getDocument(document.id);
  }

  async listDocuments(query: Record<string, string | undefined>) {
    const page = this.parsePositiveInteger(query.page, 1);
    const limit = Math.min(this.parsePositiveInteger(query.limit, 20), 100);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.projectPresentationDocument.findMany({ include: { owner: { select: { id: true, name: true, email: true } } }, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.projectPresentationDocument.count(),
    ]);
    return { items: items.map((item) => this.serializeDocument(item)), total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit)) };
  }

  async getDocument(id: string) {
    const document = await this.findDocument(id);
    return { document: this.serializeDocument(document) };
  }

  async getDocumentContent(id: string) {
    const document = await this.findDocument(id);
    if (document.status !== ProjectPresentationDocumentStatus.READY || !document.fileId) {
      throw new ConflictException('Document is not ready');
    }
    return this.filesService.getContent(document.fileId);
  }

  async retryDocument(id: string) {
    const documentId = this.parseUuid(id, 'Document is invalid');
    const updated = await this.prisma.projectPresentationDocument.updateMany({
      where: { id: documentId, status: ProjectPresentationDocumentStatus.FAILED, attempts: { lt: 3 } },
      data: { status: ProjectPresentationDocumentStatus.PENDING, progress: 0, errorMessage: null, startedAt: null, finishedAt: null, heartbeatAt: null },
    });
    if (updated.count !== 1) throw new ConflictException('Document cannot be retried');
    return this.getDocument(documentId);
  }

  async deleteDocument(id: string) {
    const document = await this.findDocument(id);
    if (document.status === ProjectPresentationDocumentStatus.RUNNING) {
      throw new ConflictException('Running document cannot be deleted');
    }
    const customCoverAssets = await this.prisma.projectPresentationDocumentAsset.findMany({
      where: { documentId: document.id, role: 'CUSTOM_COVER' },
      select: { fileId: true },
    });
    const deleted = await this.prisma.projectPresentationDocument.deleteMany({
      where: { id: document.id, status: { not: ProjectPresentationDocumentStatus.RUNNING } },
    });
    if (deleted.count !== 1) throw new ConflictException('Running document cannot be deleted');
    const cleanupTasks: Array<Promise<unknown>> = [];
    if (document.fileId) cleanupTasks.push(this.filesService.delete(document.fileId));
    for (const fileId of new Set(customCoverAssets.map((asset) => asset.fileId))) {
      cleanupTasks.push(this.filesService.deleteUnlinkedFile(fileId));
    }
    const cleanupResults = await Promise.allSettled(cleanupTasks);
    const failedCleanup = cleanupResults.find((result) => result.status === 'rejected');
    if (failedCleanup?.status === 'rejected') throw failedCleanup.reason;
  }

  private async findDraft(id: string) {
    const draftId = this.parseUuid(id, 'Draft is invalid');
    const draft = await this.prisma.projectPresentationDraft.findUnique({ where: { id: draftId }, include: draftInclude });
    if (!draft) throw new NotFoundException('Draft not found');
    return draft;
  }

  private async findDocument(id: string) {
    const documentId = this.parseUuid(id, 'Document is invalid');
    const document = await this.prisma.projectPresentationDocument.findUnique({ where: { id: documentId }, include: { owner: { select: { id: true, name: true, email: true } } } });
    if (!document) throw new NotFoundException('Document not found');
    return document;
  }

  private createSnapshot(draft: DraftRecord, title: string): ProjectPresentationSnapshotV1 {
    const objects = draft.objects.map((item) => {
      const selectedIds = this.readStringArray(item.imageIds);
      const selectedImages = selectedIds.length
        ? selectedIds.map((id) => item.object.images.find((image) => image.id === id)).filter(Boolean)
        : item.object.images.slice(0, PROJECT_PRESENTATION_MAX_IMAGES);
      const images: ProjectPresentationSnapshotImage[] = selectedImages.map((image, index) => ({
        fileId: image!.fileId,
        checksum: image!.file.checksum,
        role: 'PROJECT',
        sortOrder: index,
      }));
      return {
        sourceObjectId: item.objectId,
        sortOrder: item.sortOrder,
        title: item.manualTitle ?? item.object.title,
        description: item.manualDescription ?? this.cleanDescription(item.object.shortDescription ?? item.object.description),
        advantages: this.readStringArray(item.advantages),
        propertyClass: item.manualPropertyClass ?? item.object.propertyClass ?? 'Не указан',
        completion: item.manualCompletion ?? this.formatCompletion(item.object.completionYear, item.object.completionQuarter),
        price: item.manualPrice ?? this.formatPrice(item.object.feedPriceFrom ?? item.object.priceFrom),
        district: item.manualDistrict ?? item.object.primaryLocation?.name ?? 'Не указан',
        developer: item.manualDeveloper ?? item.object.developer?.name ?? 'Не указан',
        metro: item.manualMetro ?? (item.object.metroStations.map((link) => link.metroStation.name).join(', ') || 'Не указано'),
        images,
      };
    });
    const allImages = draft.objects.flatMap((item) => item.object.images);
    const coverImage = (draft.coverImageId ? allImages.find((image) => image.id === draft.coverImageId) : null) ?? allImages[0] ?? null;
    const coverSnapshotImage: ProjectPresentationSnapshotImage | null = draft.coverFile
      ? { fileId: draft.coverFile.id, checksum: draft.coverFile.checksum, role: 'COVER', sortOrder: 0 }
      : coverImage
        ? { fileId: coverImage.fileId, checksum: coverImage.file.checksum, role: 'COVER', sortOrder: 0 }
        : null;
    return {
      schemaVersion: 1,
      templateVersion: draft.templateVersion,
      page: { width: PROJECT_PRESENTATION_PAGE_WIDTH, height: PROJECT_PRESENTATION_PAGE_HEIGHT },
      requestedAt: new Date().toISOString(),
      title,
      cover: {
        title: draft.coverTitle ?? title,
        subtitle: draft.coverSubtitle ?? '',
        clientName: draft.clientName ?? '',
        issueLabel: draft.issueLabel ?? '',
        image: coverSnapshotImage,
      },
      cta: { label: '@FluffyWhite', url: 'https://t.me/FluffyWhite' },
      broker: {
        name: draft.owner.name ?? draft.owner.email,
        phone: draft.owner.brokerPhone ?? '',
        email: draft.owner.brokerEmail ?? draft.owner.email,
        profilePhoto: draft.owner.profilePhotoFile
          ? { fileId: draft.owner.profilePhotoFile.id, checksum: draft.owner.profilePhotoFile.checksum, role: 'PROJECT', sortOrder: 0 }
          : null,
      },
      objects,
    };
  }

  private collectSnapshotAssets(snapshot: ProjectPresentationSnapshotV1, customCoverFileId: string | null) {
    const assets: Array<Omit<ProjectPresentationSnapshotImage, 'role'> & { sourceObjectId: string | null; role: string }> = [];
    if (snapshot.cover.image) {
      assets.push({
        ...snapshot.cover.image,
        role: snapshot.cover.image.fileId === customCoverFileId ? 'CUSTOM_COVER' : 'COVER',
        sourceObjectId: null,
      });
    }
    if (snapshot.broker.profilePhoto) assets.push({ ...snapshot.broker.profilePhoto, sourceObjectId: null });
    for (const object of snapshot.objects) {
      for (const image of object.images) assets.push({ ...image, sourceObjectId: object.sourceObjectId });
    }
    return assets;
  }

  private parseDraftObjects(value: unknown): DraftObjectInput[] {
    if (!Array.isArray(value) || value.length > PROJECT_PRESENTATION_MAX_OBJECTS) {
      throw new BadRequestException(`Draft can contain from 0 to ${PROJECT_PRESENTATION_MAX_OBJECTS} projects`);
    }
    const items = value.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Project entry is invalid');
      const item = raw as Record<string, unknown>;
      return {
        objectId: this.parseUuid(this.parseRequiredString(item.objectId, 'Project is required', 64), 'Project is invalid'),
        manualTitle: this.parseNullableString(item.manualTitle, 'Manual title', 180),
        manualDescription: this.parseNullableString(item.manualDescription, 'Manual description', 2000),
        advantages: this.parseStringArray(item.advantages, PROJECT_PRESENTATION_MAX_ADVANTAGES, 240, 'Advantages'),
        imageIds: this.parseUuidArray(item.imageIds, PROJECT_PRESENTATION_MAX_IMAGES, 'Images'),
        propertyClass: this.parseNullableString(item.propertyClass, 'Property class', 180),
        completion: this.parseNullableString(item.completion, 'Completion', 180),
        price: this.parseNullableString(item.price, 'Price', 180),
        district: this.parseNullableString(item.district, 'District', 180),
        developer: this.parseNullableString(item.developer, 'Developer', 180),
        metro: this.parseNullableString(item.metro, 'Metro', 300),
      };
    });
    if (new Set(items.map((item) => item.objectId)).size !== items.length) throw new BadRequestException('Projects must be unique');
    return items;
  }

  private serializeDraft(draft: DraftRecord) {
    return {
      id: draft.id,
      ownerUserId: draft.ownerUserId,
      owner: { id: draft.owner.id, name: draft.owner.name, email: draft.owner.email },
      title: draft.title,
      coverTitle: draft.coverTitle,
      coverSubtitle: draft.coverSubtitle,
      clientName: draft.clientName,
      issueLabel: draft.issueLabel,
      coverImageId: draft.coverImageId,
      coverFileId: draft.coverFileId,
      coverFile: draft.coverFile ? this.filesService.serializeFile(draft.coverFile) : null,
      templateVersion: draft.templateVersion,
      version: draft.version,
      objectsCount: draft.objects.length,
      objects: draft.objects.map((item) => ({
        id: item.id,
        objectId: item.objectId,
        sortOrder: item.sortOrder,
        manualTitle: item.manualTitle,
        manualDescription: item.manualDescription,
        advantages: this.readStringArray(item.advantages),
        imageIds: this.readStringArray(item.imageIds),
        propertyClass: item.manualPropertyClass,
        completion: item.manualCompletion,
        price: item.manualPrice,
        district: item.manualDistrict,
        developer: item.manualDeveloper,
        metro: item.manualMetro,
        object: this.serializeCatalogObject(item.object),
      })),
      createdAt: draft.createdAt.toISOString(),
      updatedAt: draft.updatedAt.toISOString(),
    };
  }

  private serializeCatalogObject(object: ObjectRecord) {
    return {
      id: object.id,
      title: object.title,
      slug: object.slug,
      address: object.address,
      description: this.cleanDescription(object.shortDescription ?? object.description),
      propertyClass: object.propertyClass,
      completionYear: object.completionYear,
      completionQuarter: object.completionQuarter,
      priceFrom: this.decimalToString(object.feedPriceFrom ?? object.priceFrom),
      pricePerMeterFrom: this.decimalToString(object.feedPricePerMeterFrom ?? object.pricePerMeterFrom),
      areaRange: object.feedAreaRange ?? object.apartmentAreaRange,
      developer: object.developer ? { id: object.developer.id, wpTermId: object.developer.wpTermId, name: object.developer.name, slug: object.developer.slug } : null,
      primaryLocation: object.primaryLocation ? { id: object.primaryLocation.id, wpTermId: object.primaryLocation.wpTermId, name: object.primaryLocation.name, slug: object.primaryLocation.slug, type: object.primaryLocation.type, parentId: object.primaryLocation.parentId } : null,
      metroStations: object.metroStations.map((link) => ({ id: link.metroStation.id, wpTermId: link.metroStation.wpTermId, name: link.metroStation.name, slug: link.metroStation.slug, lineName: link.metroStation.lineName, lineColor: link.metroStation.lineColor, sortOrder: link.sortOrder })),
      images: object.images.map((image) => ({ id: image.id, file: this.filesService.serializeFile(image.file), sortOrder: image.sortOrder, isCover: image.isCover, section: image.section, alt: image.alt, title: image.title, sourceMetaKey: image.sourceMetaKey, createdAt: image.createdAt.toISOString(), updatedAt: image.updatedAt.toISOString() })),
    };
  }

  private serializeDocument(document: { id: string; ownerUserId: string; draftId: string | null; title: string; status: ProjectPresentationDocumentStatus; templateVersion: string; objectsCount: number; progress: number; attempts: number; errorMessage: string | null; createdAt: Date; updatedAt: Date; startedAt: Date | null; finishedAt: Date | null; fileId: string | null; owner?: { id: string; name: string | null; email: string } }) {
    return { id: document.id, ownerUserId: document.ownerUserId, createdBy: document.owner ?? { id: document.ownerUserId, name: null, email: '' }, draftId: document.draftId, title: document.title, status: document.status, templateVersion: document.templateVersion, objectsCount: document.objectsCount, progress: document.progress, attempts: document.attempts, errorMessage: document.errorMessage, createdAt: document.createdAt.toISOString(), updatedAt: document.updatedAt.toISOString(), startedAt: document.startedAt?.toISOString() ?? null, finishedAt: document.finishedAt?.toISOString() ?? null, canDownload: document.status === ProjectPresentationDocumentStatus.READY && Boolean(document.fileId) };
  }

  private ensureImageBelongsToDraft(draft: DraftRecord, imageId: string) {
    if (!draft.objects.some((item) => item.object.images.some((image) => image.id === imageId))) throw new BadRequestException('Cover image does not belong to the draft projects');
  }
  private parseVersion(value: unknown) { const version = Number(value); if (!Number.isInteger(version) || version < 1) throw new BadRequestException('Draft version is invalid'); return version; }
  private parseRequiredString(value: unknown, message: string, max: number) { if (typeof value !== 'string' || !value.trim()) throw new BadRequestException(message); if (value.trim().length > max) throw new BadRequestException(`${message}: too long`); return value.trim(); }
  private parseNullableString(value: unknown, label: string, max: number) { if (value === undefined || value === null || value === '') return null; if (typeof value !== 'string') throw new BadRequestException(`${label} is invalid`); const text = value.trim(); if (text.length > max) throw new BadRequestException(`${label} is too long`); return text || null; }
  private parseUuid(value: string, message: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) throw new BadRequestException(message); return value; }
  private parseNullableUuid(value: unknown, message: string) { if (value === undefined || value === null || value === '') return null; return this.parseUuid(this.parseRequiredString(value, message, 64), message); }
  private parseStringArray(value: unknown, maxItems: number, maxLength: number, label: string) { if (value === undefined || value === null) return []; if (!Array.isArray(value) || value.length > maxItems) throw new BadRequestException(`${label} is invalid`); return value.map((item) => this.parseRequiredString(item, `${label} item is invalid`, maxLength)); }
  private parseUuidArray(value: unknown, maxItems: number, label: string) { const values = this.parseStringArray(value, maxItems, 64, label).map((item) => this.parseUuid(item, `${label} item is invalid`)); if (new Set(values).size !== values.length) throw new BadRequestException(`${label} must be unique`); return values; }
  private readStringArray(value: Prisma.JsonValue) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []; }
  private parsePositiveInteger(value: string | undefined, fallback: number) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback; }
  private decimalToString(value: Prisma.Decimal | null) { return value?.toString() ?? null; }
  private formatPrice(value: Prisma.Decimal | null) { return value ? `от ${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Number(value.toString()))} ₽` : 'По запросу'; }
  private formatCompletion(year: number | null, quarter: number | null) { return year ? (quarter ? `${quarter} кв. ${year}` : String(year)) : 'Не указан'; }
  private cleanDescription(value: string | null) { return (value ?? '').replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 2000); }
}
