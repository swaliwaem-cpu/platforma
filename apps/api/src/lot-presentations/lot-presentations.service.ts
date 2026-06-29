import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { FeedUnitStatus, ObjectStatus, Prisma } from '@prisma/client';

import { AuthenticatedUser } from '../auth/auth.types';
import { FilesService } from '../files/files.service';
import { PrismaService } from '../prisma/prisma.service';
import { createSearchContainsFilters } from '../search/search-filters';
import {
  LotPresentationsPdfService,
  PdfPresentationGroup,
  PdfPresentationUnit,
} from './lot-presentations-pdf.service';

const presentationStatuses = [
  FeedUnitStatus.AVAILABLE,
  FeedUnitStatus.BOOKED,
  FeedUnitStatus.RESERVED,
] as const;
const maxDocumentUnits = 80;
const maxPresentationLotsListLimit = 500;

const presentationLotInclude = {
  residentialDetails: true,
  commercialDetails: true,
  media: {
    include: {
      mediaAsset: {
        include: {
          file: true,
        },
      },
    },
    orderBy: {
      sortOrder: 'asc' as const,
    },
  },
  object: {
    include: {
      developer: true,
      primaryLocation: true,
    },
  },
} as const;

const collectionItemsOrderBy = [
  {
    sortOrder: 'asc',
  },
  {
    createdAt: 'asc',
  },
] satisfies Prisma.LotPresentationCollectionItemOrderByWithRelationInput[];

const collectionInclude = {
  items: {
    include: {
      unit: {
        include: presentationLotInclude,
      },
    },
    orderBy: collectionItemsOrderBy,
  },
  _count: {
    select: {
      items: true,
    },
  },
} as const;

const workspaceInclude = {
  unit: {
    include: presentationLotInclude,
  },
} satisfies Prisma.LotPresentationWorkspaceItemInclude;

const documentInclude = {
  file: true,
  items: {
    select: {
      unitId: true,
      sortOrder: true,
    },
    orderBy: {
      sortOrder: 'asc' as const,
    },
  },
} as const;

const pdfUnitInclude = {
  residentialDetails: true,
  commercialDetails: true,
  media: {
    include: {
      mediaAsset: {
        include: {
          file: true,
        },
      },
    },
    orderBy: {
      sortOrder: 'asc' as const,
    },
  },
  object: {
    include: {
      developer: true,
      primaryLocation: true,
      images: {
        include: {
          file: true,
        },
        orderBy: {
          sortOrder: 'asc' as const,
        },
      },
    },
  },
} as const;

type PresentationLotRecord = Prisma.FeedUnitGetPayload<{ include: typeof presentationLotInclude }>;
type PresentationFeedMediaFileRecord = NonNullable<PresentationLotRecord['media'][number]['mediaAsset']['file']>;
type PresentationCollectionRecord = Prisma.LotPresentationCollectionGetPayload<{ include: typeof collectionInclude }>;
type PresentationWorkspaceItemRecord = Prisma.LotPresentationWorkspaceItemGetPayload<{
  include: typeof workspaceInclude;
}>;
type PresentationDocumentRecord = Prisma.LotPresentationDocumentGetPayload<{ include: typeof documentInclude }>;
type PdfUnitRecord = Prisma.FeedUnitGetPayload<{ include: typeof pdfUnitInclude }>;

@Injectable()
export class LotPresentationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly filesService: FilesService,
    private readonly pdfService: LotPresentationsPdfService,
  ) {}

  async listLots(query: Record<string, string | undefined>, actor: AuthenticatedUser) {
    const page = this.parsePositiveInteger(query.page, 1);
    const limit = Math.min(this.parsePositiveInteger(query.limit, 30), maxPresentationLotsListLimit);
    const where = this.createPresentationLotWhere(query);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.feedUnit.findMany({
        where,
        include: presentationLotInclude,
        orderBy: this.getPriceOrderBy(),
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.feedUnit.count({ where }),
    ]);
    const collectionIdsByUnitId = await this.getCollectionIdsByUnitId(items.map((item) => item.id), actor.id);

    return {
      items: items.map((unit) => this.serializeLot(unit, collectionIdsByUnitId.get(unit.id) ?? [])),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async getWorkspace(actor: AuthenticatedUser) {
    const items = await this.prisma.lotPresentationWorkspaceItem.findMany({
      where: {
        userId: actor.id,
      },
      include: workspaceInclude,
      orderBy: [
        {
          sortOrder: 'asc',
        },
        {
          createdAt: 'asc',
        },
      ],
    });
    const collectionIdsByUnitId = await this.getCollectionIdsByUnitId(items.map((item) => item.unitId), actor.id);

    return {
      items: items.map((item) => this.serializeWorkspaceItem(item, collectionIdsByUnitId.get(item.unitId) ?? [])),
    };
  }

  async addWorkspaceItem(body: Record<string, unknown>, actor: AuthenticatedUser) {
    const unitId = this.parseUuid(this.parseRequiredString(body.unitId, 'Lot is required'), 'Lot is invalid');

    await this.ensurePresentationUnitExists(unitId);

    const currentMaxOrder = await this.prisma.lotPresentationWorkspaceItem.aggregate({
      where: {
        userId: actor.id,
      },
      _max: {
        sortOrder: true,
      },
    });

    await this.prisma.lotPresentationWorkspaceItem.upsert({
      where: {
        userId_unitId: {
          userId: actor.id,
          unitId,
        },
      },
      update: {},
      create: {
        userId: actor.id,
        unitId,
        sortOrder: (currentMaxOrder._max.sortOrder ?? -1) + 1,
      },
    });

    return this.getWorkspace(actor);
  }

  async clearWorkspace(actor: AuthenticatedUser) {
    await this.prisma.lotPresentationWorkspaceItem.deleteMany({
      where: {
        userId: actor.id,
      },
    });
  }

  async removeWorkspaceItem(unitId: string, actor: AuthenticatedUser) {
    const normalizedUnitId = this.parseUuid(unitId, 'Lot is invalid');

    await this.prisma.lotPresentationWorkspaceItem.deleteMany({
      where: {
        userId: actor.id,
        unitId: normalizedUnitId,
      },
    });
  }

  async updateWorkspaceItemComment(unitId: string, body: Record<string, unknown>, actor: AuthenticatedUser) {
    const normalizedUnitId = this.parseUuid(unitId, 'Lot is invalid');
    const comment = this.parseOptionalComment(body.comment);
    const existingItem = await this.prisma.lotPresentationWorkspaceItem.findUnique({
      where: {
        userId_unitId: {
          userId: actor.id,
          unitId: normalizedUnitId,
        },
      },
      select: {
        id: true,
      },
    });

    if (!existingItem) {
      throw new NotFoundException('Workspace item not found');
    }

    const updatedItem = await this.prisma.lotPresentationWorkspaceItem.update({
      where: {
        id: existingItem.id,
      },
      data: {
        comment,
      },
      include: workspaceInclude,
    });
    const collectionIdsByUnitId = await this.getCollectionIdsByUnitId([updatedItem.unitId], actor.id);

    return {
      item: this.serializeWorkspaceItem(updatedItem, collectionIdsByUnitId.get(updatedItem.unitId) ?? []),
    };
  }

  async listCollections(query: Record<string, string | undefined>, actor: AuthenticatedUser) {
    const requestedUnitId = query.unitId ? this.parseUuid(query.unitId, 'Lot is invalid') : null;
    const collections = await this.prisma.lotPresentationCollection.findMany({
      where: {
        userId: actor.id,
      },
      include: collectionInclude,
      orderBy: [
        {
          updatedAt: 'desc',
        },
        {
          createdAt: 'desc',
        },
      ],
    });
    const unitIds = collections.flatMap((collection) => collection.items.map((item) => item.unitId));
    const collectionIdsByUnitId = await this.getCollectionIdsByUnitId(unitIds, actor.id);

    return {
      items: collections.map((collection) =>
        this.serializeCollection(collection, collectionIdsByUnitId, requestedUnitId),
      ),
    };
  }

  async createCollection(body: Record<string, unknown>, actor: AuthenticatedUser) {
    const name = this.parseCollectionName(body.name);
    const collection = await this.prisma.lotPresentationCollection.create({
      data: {
        name,
        userId: actor.id,
      },
      include: collectionInclude,
    });

    return {
      collection: this.serializeCollection(collection, new Map(), null),
    };
  }

  async updateCollection(collectionId: string, body: Record<string, unknown>, actor: AuthenticatedUser) {
    const collection = await this.findCollectionForActor(collectionId, actor.id);
    const name = this.parseCollectionName(body.name);
    const updatedCollection = await this.prisma.lotPresentationCollection.update({
      where: {
        id: collection.id,
      },
      data: {
        name,
      },
      include: collectionInclude,
    });
    const collectionIdsByUnitId = await this.getCollectionIdsByUnitId(
      updatedCollection.items.map((item) => item.unitId),
      actor.id,
    );

    return {
      collection: this.serializeCollection(updatedCollection, collectionIdsByUnitId, null),
    };
  }

  async deleteCollection(collectionId: string, actor: AuthenticatedUser) {
    const collection = await this.findCollectionForActor(collectionId, actor.id);

    await this.prisma.lotPresentationCollection.delete({
      where: {
        id: collection.id,
      },
    });
  }

  async addCollectionItem(collectionId: string, body: Record<string, unknown>, actor: AuthenticatedUser) {
    const collection = await this.findCollectionForActor(collectionId, actor.id);
    const unitId = this.parseUuid(this.parseRequiredString(body.unitId, 'Lot is required'), 'Lot is invalid');

    await this.ensurePresentationUnitExists(unitId);

    const currentMaxOrder = await this.prisma.lotPresentationCollectionItem.aggregate({
      where: {
        collectionId: collection.id,
      },
      _max: {
        sortOrder: true,
      },
    });

    await this.prisma.lotPresentationCollectionItem.upsert({
      where: {
        collectionId_unitId: {
          collectionId: collection.id,
          unitId,
        },
      },
      update: {},
      create: {
        collectionId: collection.id,
        unitId,
        sortOrder: (currentMaxOrder._max.sortOrder ?? -1) + 1,
      },
    });

    return this.getCollectionResponse(collection.id, actor.id, unitId);
  }

  async updateCollectionItemComment(collectionId: string, unitId: string, body: Record<string, unknown>, actor: AuthenticatedUser) {
    const collection = await this.findCollectionForActor(collectionId, actor.id);
    const normalizedUnitId = this.parseUuid(unitId, 'Lot is invalid');
    const comment = this.parseOptionalComment(body.comment);
    const updateResult = await this.prisma.lotPresentationCollectionItem.updateMany({
      where: {
        collectionId: collection.id,
        unitId: normalizedUnitId,
      },
      data: {
        comment,
      },
    });

    if (updateResult.count === 0) {
      throw new NotFoundException('Collection item not found');
    }

    return this.getCollectionResponse(collection.id, actor.id, normalizedUnitId);
  }

  async removeCollectionItem(collectionId: string, unitId: string, actor: AuthenticatedUser) {
    const collection = await this.findCollectionForActor(collectionId, actor.id);
    const normalizedUnitId = this.parseUuid(unitId, 'Lot is invalid');

    await this.prisma.lotPresentationCollectionItem.deleteMany({
      where: {
        collectionId: collection.id,
        unitId: normalizedUnitId,
      },
    });
  }

  async createDocument(body: Record<string, unknown>, actor: AuthenticatedUser) {
    if (!actor.brokerPhone || !actor.brokerEmail) {
      throw new BadRequestException('Заполните телефон и почту брокера в профиле перед скачиванием презентации');
    }

    const collectionId = body.collectionId === undefined || body.collectionId === null
      ? null
      : this.parseUuid(this.parseRequiredString(body.collectionId, 'Collection is invalid'), 'Collection is invalid');
    const collection = collectionId ? await this.findCollectionForActor(collectionId, actor.id) : null;
    const explicitUnitIds = this.parseOptionalUnitIds(body.unitIds);
    const unitIds = explicitUnitIds.length > 0
      ? explicitUnitIds
      : collection
        ? await this.getCollectionUnitIds(collection.id)
        : [];

    if (unitIds.length === 0) {
      throw new BadRequestException('Выберите хотя бы один лот для презентации');
    }

    if (unitIds.length > maxDocumentUnits) {
      throw new BadRequestException(`В одной презентации может быть не больше ${maxDocumentUnits} лотов`);
    }

    const groups = await this.getPdfGroups(unitIds);
    const missingPlanUnit = groups.flatMap((group) => group.units).find((unit) => !this.hasPlanImage(unit));

    if (missingPlanUnit) {
      throw new BadRequestException(`Планировка отсутствует в лоте: ${this.getLotTitle(missingPlanUnit)}`);
    }

    const title = this.parseOptionalDocumentTitle(body.title) ?? this.getDocumentTitle(collection?.name ?? null, groups);
    const pdfBuffer = await this.pdfService.generate({
      broker: {
        name: actor.name ?? actor.email,
        phone: actor.brokerPhone,
        email: actor.brokerEmail,
      },
      groups,
      title,
    });
    const uploadedFile = await this.filesService.uploadFile(
      {
        fieldname: 'file',
        buffer: pdfBuffer,
        encoding: '7bit',
        mimetype: 'application/pdf',
        originalname: `${this.slugifyFilename(title)}.pdf`,
        size: pdfBuffer.length,
      },
      actor,
      'pdf',
    );
    const flatUnits = groups.flatMap((group) => group.units);
    const document = await this.prisma.lotPresentationDocument.create({
      data: {
        userId: actor.id,
        collectionId: collection?.id ?? null,
        fileId: uploadedFile.file.id,
        title,
        unitsCount: flatUnits.length,
        items: {
          create: flatUnits.map((unit, index) => ({
            unitId: unit.id,
            sortOrder: index,
          })),
        },
      },
      include: documentInclude,
    });

    return {
      document: this.serializeDocument(document),
    };
  }

  async listDocuments(query: Record<string, string | undefined>, actor: AuthenticatedUser) {
    const page = this.parsePositiveInteger(query.page, 1);
    const limit = Math.min(this.parsePositiveInteger(query.limit, 20), 100);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.lotPresentationDocument.findMany({
        where: {
          userId: actor.id,
        },
        include: documentInclude,
        orderBy: {
          createdAt: 'desc',
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.lotPresentationDocument.count({
        where: {
          userId: actor.id,
        },
      }),
    ]);

    return {
      items: items.map((document) => this.serializeDocument(document)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async getDocumentContent(documentId: string, actor: AuthenticatedUser) {
    const normalizedDocumentId = this.parseUuid(documentId, 'Document is invalid');
    const document = await this.prisma.lotPresentationDocument.findFirst({
      where: {
        id: normalizedDocumentId,
        userId: actor.id,
      },
      select: {
        fileId: true,
      },
    });

    if (!document) {
      throw new NotFoundException('Document not found');
    }

    return this.filesService.getContent(document.fileId);
  }

  private createPresentationLotWhere(query: Record<string, string | undefined>): Prisma.FeedUnitWhereInput {
    const filters: Prisma.FeedUnitWhereInput[] = [
      {
        status: {
          in: [...presentationStatuses],
        },
      },
      {
        source: {
          deletedAt: null,
        },
      },
      {
        object: {
          status: ObjectStatus.PUBLISHED,
          deletedAt: null,
        },
      },
    ];
    const search = query.search?.trim();
    const objectId = query.objectId?.trim();

    if (objectId) {
      filters.push({
        objectId: this.parseUuid(objectId, 'Object is invalid'),
      });
    }

    if (search) {
      filters.push({
        OR: [
          ...createSearchContainsFilters(search, ['externalId', 'title', 'address', 'building', 'section']),
          {
            object: {
              OR: createSearchContainsFilters(search, ['title', 'address']),
            },
          },
        ],
      });
    }

    return {
      AND: filters,
    };
  }

  private getPriceOrderBy() {
    return [
      {
        effectivePrice: {
          sort: 'asc' as const,
          nulls: 'last' as const,
        },
      },
      {
        price: {
          sort: 'asc' as const,
          nulls: 'last' as const,
        },
      },
      {
        createdAt: 'desc' as const,
      },
    ] satisfies Prisma.FeedUnitOrderByWithRelationInput[];
  }

  private async findCollectionForActor(collectionId: string, userId: string) {
    const normalizedCollectionId = this.parseUuid(collectionId, 'Collection is invalid');
    const collection = await this.prisma.lotPresentationCollection.findFirst({
      where: {
        id: normalizedCollectionId,
        userId,
      },
      select: {
        id: true,
        name: true,
      },
    });

    if (!collection) {
      throw new NotFoundException('Collection not found');
    }

    return collection;
  }

  private async getCollectionResponse(collectionId: string, userId: string, requestedUnitId: string | null) {
    const collection = await this.prisma.lotPresentationCollection.findFirst({
      where: {
        id: collectionId,
        userId,
      },
      include: collectionInclude,
    });

    if (!collection) {
      throw new NotFoundException('Collection not found');
    }

    const collectionIdsByUnitId = await this.getCollectionIdsByUnitId(
      collection.items.map((item) => item.unitId),
      userId,
    );

    return {
      collection: this.serializeCollection(collection, collectionIdsByUnitId, requestedUnitId),
    };
  }

  private async ensurePresentationUnitExists(unitId: string) {
    const unit = await this.prisma.feedUnit.findFirst({
      where: {
        id: unitId,
        status: {
          in: [...presentationStatuses],
        },
        source: {
          deletedAt: null,
        },
        object: {
          status: ObjectStatus.PUBLISHED,
          deletedAt: null,
        },
      },
      select: {
        id: true,
      },
    });

    if (!unit) {
      throw new BadRequestException('Лот недоступен для презентации');
    }
  }

  private async getCollectionUnitIds(collectionId: string) {
    const items = await this.prisma.lotPresentationCollectionItem.findMany({
      where: {
        collectionId,
      },
      select: {
        unitId: true,
      },
      orderBy: [
        {
          sortOrder: 'asc',
        },
        {
          createdAt: 'asc',
        },
      ],
    });

    return items.map((item) => item.unitId);
  }

  private async getPdfGroups(unitIds: string[]): Promise<PdfPresentationGroup[]> {
    const uniqueUnitIds = [...new Set(unitIds)];
    const units = await this.prisma.feedUnit.findMany({
      where: {
        id: {
          in: uniqueUnitIds,
        },
        status: {
          in: [...presentationStatuses],
        },
        source: {
          deletedAt: null,
        },
        object: {
          status: ObjectStatus.PUBLISHED,
          deletedAt: null,
        },
      },
      include: pdfUnitInclude,
    });

    if (units.length !== uniqueUnitIds.length) {
      throw new BadRequestException('Один или несколько лотов недоступны для презентации');
    }

    const sortedUnits = [...units].sort((leftUnit, rightUnit) => this.compareUnitsByPrice(leftUnit, rightUnit));
    const groupsByObjectId = new Map<string, PdfUnitRecord[]>();

    for (const unit of sortedUnits) {
      groupsByObjectId.set(unit.objectId, [...(groupsByObjectId.get(unit.objectId) ?? []), unit]);
    }

    return [...groupsByObjectId.values()]
      .map((groupUnits) => {
        const firstUnit = groupUnits[0];

        if (!firstUnit) {
          throw new BadRequestException('Один или несколько лотов недоступны для презентации');
        }

        return {
          object: firstUnit.object,
          units: groupUnits,
        };
      })
      .sort((leftGroup, rightGroup) =>
        this.compareNullableNumbers(this.getGroupMinPrice(leftGroup.units), this.getGroupMinPrice(rightGroup.units)),
      );
  }

  private getGroupMinPrice(units: PdfUnitRecord[]) {
    return units.reduce<number | null>((currentMin, unit) => {
      const price = this.getUnitEffectivePrice(unit);

      if (price === null) {
        return currentMin;
      }

      return currentMin === null ? price : Math.min(currentMin, price);
    }, null);
  }

  private compareUnitsByPrice(leftUnit: PdfUnitRecord, rightUnit: PdfUnitRecord) {
    return (
      this.compareNullableNumbers(this.getUnitEffectivePrice(leftUnit), this.getUnitEffectivePrice(rightUnit)) ||
      this.compareNullableNumbers(this.decimalToNumber(leftUnit.area), this.decimalToNumber(rightUnit.area)) ||
      leftUnit.createdAt.getTime() - rightUnit.createdAt.getTime()
    );
  }

  private compareNullableNumbers(leftValue: number | null, rightValue: number | null) {
    if (leftValue === null && rightValue === null) {
      return 0;
    }

    if (leftValue === null) {
      return 1;
    }

    if (rightValue === null) {
      return -1;
    }

    return leftValue - rightValue;
  }

  private getUnitEffectivePrice(unit: Pick<PdfUnitRecord, 'effectivePrice' | 'discountPrice' | 'price'>) {
    return this.decimalToNumber(unit.effectivePrice) ?? this.decimalToNumber(unit.discountPrice) ?? this.decimalToNumber(unit.price);
  }

  private hasPlanImage(unit: PdfPresentationUnit) {
    return unit.media.some((media) => Boolean(media.mediaAsset.file));
  }

  private getLotTitle(unit: PdfPresentationUnit) {
    return unit.title?.trim() || unit.residentialDetails?.apartmentNumber || unit.externalId;
  }

  private async getCollectionIdsByUnitId(unitIds: string[], userId: string) {
    const uniqueUnitIds = [...new Set(unitIds)];

    if (uniqueUnitIds.length === 0) {
      return new Map<string, string[]>();
    }

    const items = await this.prisma.lotPresentationCollectionItem.findMany({
      where: {
        unitId: {
          in: uniqueUnitIds,
        },
        collection: {
          userId,
        },
      },
      select: {
        unitId: true,
        collectionId: true,
      },
    });
    const collectionIdsByUnitId = new Map<string, string[]>();

    for (const item of items) {
      collectionIdsByUnitId.set(item.unitId, [...(collectionIdsByUnitId.get(item.unitId) ?? []), item.collectionId]);
    }

    return collectionIdsByUnitId;
  }

  private serializeWorkspaceItem(item: PresentationWorkspaceItemRecord, collectionIds: string[]) {
    return {
      id: item.id,
      userId: item.userId,
      unitId: item.unitId,
      sortOrder: item.sortOrder,
      comment: item.comment,
      unit: this.serializeLot(item.unit, collectionIds),
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
    };
  }

  private serializeCollection(
    collection: PresentationCollectionRecord,
    collectionIdsByUnitId: Map<string, string[]>,
    requestedUnitId: string | null,
  ) {
    return {
      id: collection.id,
      userId: collection.userId,
      name: collection.name,
      itemsCount: collection._count.items,
      containsRequestedUnit: requestedUnitId ? collection.items.some((item) => item.unitId === requestedUnitId) : null,
      items: collection.items.map((item) => ({
        id: item.id,
        collectionId: item.collectionId,
        unitId: item.unitId,
        sortOrder: item.sortOrder,
        comment: item.comment,
        unit: this.serializeLot(item.unit, collectionIdsByUnitId.get(item.unitId) ?? []),
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
      })),
      createdAt: collection.createdAt.toISOString(),
      updatedAt: collection.updatedAt.toISOString(),
    };
  }

  private serializeLot(unit: PresentationLotRecord, collectionIds: string[]) {
    return {
      id: unit.id,
      sourceId: unit.sourceId,
      objectId: unit.objectId,
      externalId: unit.externalId,
      type: unit.type,
      status: unit.status,
      title: unit.title,
      address: unit.address,
      building: unit.building,
      section: unit.section,
      floor: unit.floor,
      rooms: unit.rooms,
      price: this.decimalToString(unit.price),
      discountPrice: this.decimalToString(unit.discountPrice),
      effectivePrice: this.decimalToString(unit.effectivePrice),
      currency: unit.currency,
      area: this.decimalToString(unit.area),
      pricePerMeter: this.decimalToString(unit.pricePerMeter),
      discountPricePerMeter: this.decimalToString(unit.discountPricePerMeter),
      effectivePricePerMeter: this.decimalToString(unit.effectivePricePerMeter),
      completionYear: unit.completionYear,
      completionQuarter: unit.completionQuarter,
      rawPayload: unit.rawPayload ?? null,
      archivedAt: unit.archivedAt?.toISOString() ?? null,
      residentialDetails: unit.residentialDetails
        ? {
            unitId: unit.residentialDetails.unitId,
            apartmentNumber: unit.residentialDetails.apartmentNumber,
            layoutType: unit.residentialDetails.layoutType,
            livingArea: this.decimalToString(unit.residentialDetails.livingArea),
            kitchenArea: this.decimalToString(unit.residentialDetails.kitchenArea),
            balconyCount: unit.residentialDetails.balconyCount,
            detailsJson: unit.residentialDetails.detailsJson,
          }
        : null,
      commercialDetails: unit.commercialDetails
        ? {
            unitId: unit.commercialDetails.unitId,
            commercialType: unit.commercialDetails.commercialType,
            entrance: unit.commercialDetails.entrance,
            ceilingHeight: this.decimalToString(unit.commercialDetails.ceilingHeight),
            powerKw: this.decimalToString(unit.commercialDetails.powerKw),
            separateEntrance: unit.commercialDetails.separateEntrance,
            detailsJson: unit.commercialDetails.detailsJson,
          }
        : null,
      media: unit.media.map((link) => ({
        id: link.mediaAsset.id,
        sourceUrl: link.mediaAsset.sourceUrl,
        file: link.mediaAsset.file ? this.serializeFeedFile(link.mediaAsset.file) : null,
        contentType: link.mediaAsset.contentType,
        checksum: link.mediaAsset.checksum,
        sortOrder: link.sortOrder,
        label: link.label,
        createdAt: link.mediaAsset.createdAt.toISOString(),
        updatedAt: link.mediaAsset.updatedAt.toISOString(),
      })),
      object: {
        id: unit.object.id,
        title: unit.object.title,
        slug: unit.object.slug,
        address: unit.object.address,
        developer: unit.object.developer
          ? {
              id: unit.object.developer.id,
              wpTermId: unit.object.developer.wpTermId,
              name: unit.object.developer.name,
              slug: unit.object.developer.slug,
            }
          : null,
        primaryLocation: unit.object.primaryLocation
          ? {
              id: unit.object.primaryLocation.id,
              wpTermId: unit.object.primaryLocation.wpTermId,
              name: unit.object.primaryLocation.name,
              slug: unit.object.primaryLocation.slug,
              type: unit.object.primaryLocation.type,
              parentId: unit.object.primaryLocation.parentId,
            }
          : null,
      },
      hasPlanImage: unit.media.some((link) => Boolean(link.mediaAsset.file)),
      collectionIds,
      createdAt: unit.createdAt.toISOString(),
      updatedAt: unit.updatedAt.toISOString(),
    };
  }

  private serializeFeedFile(file: PresentationFeedMediaFileRecord) {
    return this.filesService.serializeFile(file);
  }

  private serializeDocument(document: PresentationDocumentRecord) {
    return {
      id: document.id,
      userId: document.userId,
      collectionId: document.collectionId,
      file: this.filesService.serializeFile(document.file),
      title: document.title,
      unitsCount: document.unitsCount,
      items: document.items.map((item) => ({
        unitId: item.unitId,
        sortOrder: item.sortOrder,
      })),
      createdAt: document.createdAt.toISOString(),
    };
  }

  private parseCollectionName(value: unknown) {
    const name = this.parseRequiredString(value, 'Collection name is required');

    if (name.length > 120) {
      throw new BadRequestException('Collection name is too long');
    }

    return name;
  }

  private parseOptionalDocumentTitle(value: unknown) {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException('Document title is invalid');
    }

    const title = value.trim();

    if (!title) {
      return null;
    }

    if (title.length > 180) {
      throw new BadRequestException('Document title is too long');
    }

    return title;
  }

  private parseOptionalComment(value: unknown) {
    if (value === undefined || value === null) {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException('Comment is invalid');
    }

    const comment = value.trim();

    if (!comment) {
      return null;
    }

    if (comment.length > 1000) {
      throw new BadRequestException('Comment is too long');
    }

    return comment;
  }

  private getDocumentTitle(collectionName: string | null, groups: PdfPresentationGroup[]) {
    if (collectionName) {
      return collectionName;
    }

    const firstGroup = groups[0];
    const firstLot = firstGroup?.units[0];

    if (!firstGroup || !firstLot) {
      return 'Презентация лотов';
    }

    return groups.length === 1 && firstGroup.units.length === 1
      ? `${firstGroup.object.title} - ${this.getLotTitle(firstLot)}`
      : `Презентация лотов - ${new Date().toLocaleDateString('ru-RU')}`;
  }

  private parseOptionalUnitIds(value: unknown) {
    if (value === undefined || value === null) {
      return [];
    }

    if (!Array.isArray(value)) {
      throw new BadRequestException('Lots must be an array');
    }

    return [...new Set(value.map((item) => this.parseUuid(this.parseRequiredString(item, 'Lot is invalid'), 'Lot is invalid')))];
  }

  private parseRequiredString(value: unknown, message: string) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new BadRequestException(message);
    }

    return value.trim();
  }

  private parseUuid(value: string, message: string) {
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

    if (!uuidPattern.test(value)) {
      throw new BadRequestException(message);
    }

    return value;
  }

  private parsePositiveInteger(value: string | undefined, fallback: number) {
    if (!value) {
      return fallback;
    }

    const parsed = Number(value);

    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }

  private decimalToString(value: Prisma.Decimal | null) {
    return value?.toString() ?? null;
  }

  private decimalToNumber(value: Prisma.Decimal | null) {
    if (!value) {
      return null;
    }

    const parsed = Number(value.toString());

    return Number.isFinite(parsed) ? parsed : null;
  }

  private slugifyFilename(value: string) {
    const slug = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9а-яё]+/giu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 80);

    return slug || 'lot-presentation';
  }
}
