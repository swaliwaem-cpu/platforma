import { BadRequestException, Injectable } from '@nestjs/common';
import { LocationType, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { createSearchContainsFilters } from '../search/search-filters';

type DirectoryQuery = {
  search?: string;
  limit?: string;
  type?: string;
};

@Injectable()
export class DirectoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async listDevelopers(query: DirectoryQuery) {
    const search = query.search?.trim();
    const limit = this.parseLimit(query.limit);
    const where: Prisma.DeveloperWhereInput = search
      ? {
          OR: createSearchContainsFilters(search, ['name', 'slug']),
        }
      : {};

    const items = await this.prisma.developer.findMany({
      where,
      orderBy: {
        name: 'asc',
      },
      take: limit,
    });

    return {
      items: items.map((developer) => ({
        id: developer.id,
        wpTermId: developer.wpTermId,
        name: developer.name,
        slug: developer.slug,
      })),
    };
  }

  async listLocations(query: DirectoryQuery) {
    const search = query.search?.trim();
    const limit = this.parseLimit(query.limit);
    const type = query.type ? this.parseLocationType(query.type) : undefined;
    const filters: Prisma.LocationWhereInput[] = [];

    if (type) {
      filters.push({ type });
    }

    if (search) {
      filters.push({
        OR: createSearchContainsFilters(search, ['name', 'slug']),
      });
    }

    const items = await this.prisma.location.findMany({
      where: filters.length ? { AND: filters } : {},
      orderBy: [
        {
          type: 'asc',
        },
        {
          name: 'asc',
        },
      ],
      take: limit,
    });

    return {
      items: items.map((location) => ({
        id: location.id,
        wpTermId: location.wpTermId,
        name: location.name,
        slug: location.slug,
        type: location.type,
        parentId: location.parentId,
      })),
    };
  }

  async listMetroStations(query: DirectoryQuery) {
    const search = query.search?.trim();
    const limit = this.parseLimit(query.limit);
    const where: Prisma.MetroStationWhereInput = search
      ? {
          OR: createSearchContainsFilters(search, ['name', 'slug', 'lineName']),
        }
      : {};

    const items = await this.prisma.metroStation.findMany({
      where,
      orderBy: [
        {
          lineName: 'asc',
        },
        {
          name: 'asc',
        },
      ],
      take: limit,
    });

    return {
      items: items.map((station) => ({
        id: station.id,
        wpTermId: station.wpTermId,
        name: station.name,
        slug: station.slug,
        lineName: station.lineName,
        lineColor: station.lineColor,
      })),
    };
  }

  private parseLimit(value: string | undefined) {
    if (!value) {
      return 200;
    }

    const parsed = Number(value);

    if (!Number.isInteger(parsed) || parsed < 1) {
      return 200;
    }

    return Math.min(parsed, 500);
  }

  private parseLocationType(value: string) {
    const normalizedType = value.trim().toUpperCase();

    if (!Object.values(LocationType).includes(normalizedType as LocationType)) {
      throw new BadRequestException('Location type is invalid');
    }

    return normalizedType as LocationType;
  }
}
