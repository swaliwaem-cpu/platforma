import { BadRequestException, Injectable } from '@nestjs/common';
import { CatalogQuickLinkType, ObjectStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

const catalogQuickLinkInclude = {
  developer: true,
  object: true,
} as const;

type CatalogQuickLinkRecord = Prisma.CatalogQuickLinkGetPayload<{ include: typeof catalogQuickLinkInclude }>;

type UpdateCatalogLinksBody = {
  items?: unknown;
};

type CatalogQuickLinkInput = {
  id?: string;
  type: CatalogQuickLinkType;
  label: string;
  sortOrder: number;
  isEnabled: boolean;
  developerId: string | null;
  objectId: string | null;
  krtName: string | null;
};

@Injectable()
export class CatalogLinksService {
  constructor(private readonly prisma: PrismaService) {}

  async listPublic() {
    const links = await this.prisma.catalogQuickLink.findMany({
      where: {
        isEnabled: true,
      },
      include: catalogQuickLinkInclude,
      orderBy: this.orderBy(),
    });

    return {
      items: links
        .map((link) => this.serializePublicLink(link))
        .filter((link): link is NonNullable<typeof link> => link !== null),
    };
  }

  async listAdmin() {
    const links = await this.prisma.catalogQuickLink.findMany({
      include: catalogQuickLinkInclude,
      orderBy: this.orderBy(),
    });

    return {
      items: links.map((link) => this.serializeAdminLink(link)),
    };
  }

  async updateAdmin(body: UpdateCatalogLinksBody) {
    const links = await this.parseCatalogLinksBody(body);
    const existingIds = links.flatMap((link) => (link.id ? [link.id] : []));

    await this.prisma.$transaction(async (tx) => {
      await tx.catalogQuickLink.deleteMany({
        where: {
          id: {
            notIn: existingIds,
          },
        },
      });

      for (const link of links) {
        const data = this.toCatalogQuickLinkData(link);

        if (link.id) {
          await tx.catalogQuickLink.update({
            where: {
              id: link.id,
            },
            data,
          });
          continue;
        }

        await tx.catalogQuickLink.create({
          data,
        });
      }
    });

    return this.listAdmin();
  }

  private orderBy() {
    return [
      {
        type: 'asc' as const,
      },
      {
        sortOrder: 'asc' as const,
      },
      {
        createdAt: 'asc' as const,
      },
    ];
  }

  private async parseCatalogLinksBody(body: UpdateCatalogLinksBody) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.items)) {
      throw new BadRequestException('Catalog links items are required');
    }

    const links: CatalogQuickLinkInput[] = [];

    for (const [index, item] of body.items.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new BadRequestException('Catalog link item is invalid');
      }

      links.push(await this.parseCatalogLinkInput(item as Record<string, unknown>, index));
    }

    return links;
  }

  private async parseCatalogLinkInput(item: Record<string, unknown>, index: number) {
    const type = this.parseType(item.type);
    const label = this.parseRequiredString(item.label, 'Catalog link label is required', 160);
    const sortOrder = this.parseSortOrder(item.sortOrder, index);
    const isEnabled = this.parseBoolean(item.isEnabled, true);
    const id = this.parseOptionalUuid(item.id, 'Catalog link is invalid') ?? undefined;
    let developerId = this.parseOptionalUuid(item.developerId, 'Developer is invalid');
    let objectId = this.parseOptionalUuid(item.objectId, 'Object is invalid');
    let krtName = this.parseNullableString(item.krtName, 'KRT name', 240);

    if (type !== CatalogQuickLinkType.DEVELOPER) {
      developerId = null;
    }

    if (type !== CatalogQuickLinkType.KRT) {
      krtName = null;
    }

    if (type !== CatalogQuickLinkType.SALES_START) {
      objectId = null;
    }

    if (type === CatalogQuickLinkType.DEVELOPER) {
      if (isEnabled && !developerId) {
        throw new BadRequestException('Developer target is required');
      }

      if (developerId) {
        await this.ensureDeveloperExists(developerId);
      }
    }

    if (type === CatalogQuickLinkType.KRT && isEnabled && !krtName) {
      throw new BadRequestException('KRT target is required');
    }

    if (type === CatalogQuickLinkType.SALES_START) {
      if (isEnabled && !objectId) {
        throw new BadRequestException('Object target is required');
      }

      if (objectId) {
        await this.ensurePublishedObjectExists(objectId);
      }
    }

    return {
      ...(id ? { id } : {}),
      type,
      label,
      sortOrder,
      isEnabled,
      developerId,
      objectId,
      krtName,
    };
  }

  private toCatalogQuickLinkData(link: CatalogQuickLinkInput) {
    return {
      type: link.type,
      label: link.label,
      sortOrder: link.sortOrder,
      isEnabled: link.isEnabled,
      developerId: link.developerId,
      objectId: link.objectId,
      krtName: link.krtName,
    };
  }

  private serializePublicLink(link: CatalogQuickLinkRecord) {
    if (link.type === CatalogQuickLinkType.DEVELOPER) {
      if (!link.developerId || !link.developer) {
        return null;
      }

      return {
        id: link.id,
        type: link.type,
        label: link.label,
        sortOrder: link.sortOrder,
        developerId: link.developerId,
        krtName: null,
        objectSlug: null,
      };
    }

    if (link.type === CatalogQuickLinkType.KRT) {
      const krtName = link.krtName?.trim();

      if (!krtName) {
        return null;
      }

      return {
        id: link.id,
        type: link.type,
        label: link.label,
        sortOrder: link.sortOrder,
        developerId: null,
        krtName,
        objectSlug: null,
      };
    }

    if (!link.objectId || !link.object || link.object.status !== ObjectStatus.PUBLISHED) {
      return null;
    }

    return {
      id: link.id,
      type: link.type,
      label: link.label,
      sortOrder: link.sortOrder,
      developerId: null,
      krtName: null,
      objectSlug: link.object.slug,
    };
  }

  private serializeAdminLink(link: CatalogQuickLinkRecord) {
    return {
      id: link.id,
      type: link.type,
      label: link.label,
      sortOrder: link.sortOrder,
      isEnabled: link.isEnabled,
      developerId: link.developerId,
      objectId: link.objectId,
      krtName: link.krtName,
      developer: link.developer
        ? {
            id: link.developer.id,
            wpTermId: link.developer.wpTermId,
            name: link.developer.name,
            slug: link.developer.slug,
          }
        : null,
      object: link.object
        ? {
            id: link.object.id,
            title: link.object.title,
            slug: link.object.slug,
            status: link.object.status,
          }
        : null,
      createdAt: link.createdAt.toISOString(),
      updatedAt: link.updatedAt.toISOString(),
    };
  }

  private parseType(value: unknown) {
    if (typeof value !== 'string') {
      throw new BadRequestException('Catalog link type is invalid');
    }

    const type = value.trim().toUpperCase();

    if (!Object.values(CatalogQuickLinkType).includes(type as CatalogQuickLinkType)) {
      throw new BadRequestException('Catalog link type is invalid');
    }

    return type as CatalogQuickLinkType;
  }

  private parseRequiredString(value: unknown, message: string, maxLength: number) {
    if (typeof value !== 'string') {
      throw new BadRequestException(message);
    }

    const normalized = value.trim();

    if (!normalized || normalized.length > maxLength) {
      throw new BadRequestException(message);
    }

    return normalized;
  }

  private parseNullableString(value: unknown, fieldName: string, maxLength: number) {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    if (typeof value !== 'string') {
      throw new BadRequestException(`${fieldName} is invalid`);
    }

    const normalized = value.trim();

    if (!normalized) {
      return null;
    }

    if (normalized.length > maxLength) {
      throw new BadRequestException(`${fieldName} is too long`);
    }

    return normalized;
  }

  private parseSortOrder(value: unknown, fallback: number) {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }

    const parsed = typeof value === 'number' ? value : Number(value);

    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
      throw new BadRequestException('Catalog link sort order is invalid');
    }

    return parsed;
  }

  private parseBoolean(value: unknown, fallback: boolean) {
    if (value === undefined || value === null || value === '') {
      return fallback;
    }

    if (typeof value !== 'boolean') {
      throw new BadRequestException('Catalog link enabled flag is invalid');
    }

    return value;
  }

  private parseOptionalUuid(value: unknown, message: string) {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    if (typeof value !== 'string' || !this.isUuid(value.trim())) {
      throw new BadRequestException(message);
    }

    return value.trim();
  }

  private isUuid(value: string) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  private async ensureDeveloperExists(developerId: string) {
    const count = await this.prisma.developer.count({
      where: {
        id: developerId,
      },
    });

    if (count === 0) {
      throw new BadRequestException('Developer is invalid');
    }
  }

  private async ensurePublishedObjectExists(objectId: string) {
    const count = await this.prisma.realEstateObject.count({
      where: {
        id: objectId,
        status: ObjectStatus.PUBLISHED,
        deletedAt: null,
      },
    });

    if (count === 0) {
      throw new BadRequestException('Object is invalid');
    }
  }
}
