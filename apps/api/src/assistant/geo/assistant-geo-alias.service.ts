import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AssistantGeoAliasInput } from '@platforma/shared' with { 'resolution-mode': 'import' };

import { PrismaService } from '../../prisma/prisma.service';
import { normalizePlaceQuery } from './assistant-place-resolver.service';

@Injectable()
export class AssistantGeoAliasService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const aliases = await this.prisma.assistantGeoAlias.findMany({
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    });
    return { items: aliases.map(serializeAlias) };
  }

  async save(actorId: string, body: unknown) {
    const input = parseAliasInput(body);
    const alias = await this.prisma.assistantGeoAlias.upsert({
      where: {
        normalizedQuery_locale_country: {
          normalizedQuery: normalizePlaceQuery(input.query),
          locale: input.locale,
          country: input.country ?? '',
        },
      },
      update: {
        query: input.query,
        ...input.candidate,
        createdByUserId: actorId,
      },
      create: {
        normalizedQuery: normalizePlaceQuery(input.query),
        query: input.query,
        locale: input.locale,
        country: input.country ?? '',
        ...input.candidate,
        createdByUserId: actorId,
      },
    });
    return { alias: serializeAlias(alias) };
  }

  async remove(aliasId: string) {
    if (!isUuid(aliasId)) throw new BadRequestException('ASSISTANT_GEO_ALIAS_ID_INVALID');
    const result = await this.prisma.assistantGeoAlias.deleteMany({ where: { id: aliasId } });
    if (result.count === 0) throw new NotFoundException('ASSISTANT_GEO_ALIAS_NOT_FOUND');
    return { deleted: true };
  }
}

function parseAliasInput(value: unknown): AssistantGeoAliasInput {
  if (!isRecord(value) || !isRecord(value.candidate)) {
    throw new BadRequestException('ASSISTANT_GEO_ALIAS_INPUT_INVALID');
  }
  const query = readText(value.query, 240);
  const locale = typeof value.locale === 'string' && /^[a-z]{2}(?:-[A-Z]{2})?$/u.test(value.locale)
    ? value.locale
    : null;
  const country = value.country === null
    ? null
    : typeof value.country === 'string' && /^[a-z]{2}$/u.test(value.country)
      ? value.country
      : undefined;
  const label = readText(value.candidate.label, 300);
  const latitude = readCoordinate(value.candidate.latitude, -90, 90);
  const longitude = readCoordinate(value.candidate.longitude, -180, 180);
  const city = value.candidate.city === null ? null : readText(value.candidate.city, 160);
  const countryCode = value.candidate.countryCode === null
    ? null
    : typeof value.candidate.countryCode === 'string' && /^[a-z]{2}$/u.test(value.candidate.countryCode)
      ? value.candidate.countryCode
      : undefined;
  if (!query || !locale || country === undefined || !label || latitude === null || longitude === null
    || city === undefined || countryCode === undefined) {
    throw new BadRequestException('ASSISTANT_GEO_ALIAS_INPUT_INVALID');
  }
  return { query, locale, country, candidate: { label, latitude, longitude, city, countryCode } };
}

function serializeAlias(alias: {
  id: string;
  query: string;
  locale: string;
  country: string;
  label: string;
  latitude: unknown;
  longitude: unknown;
  city: string | null;
  countryCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: alias.id,
    query: alias.query,
    locale: alias.locale,
    country: alias.country || null,
    label: alias.label,
    latitude: Number(alias.latitude),
    longitude: Number(alias.longitude),
    city: alias.city,
    countryCode: alias.countryCode,
    createdAt: alias.createdAt.toISOString(),
    updatedAt: alias.updatedAt.toISOString(),
  };
}

function readText(value: unknown, maximum: number) {
  return typeof value === 'string' && value.trim() && value.trim().length <= maximum ? value.trim() : null;
}

function readCoordinate(value: unknown, minimum: number, maximum: number) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
