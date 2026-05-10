import { LocationType, ObjectFileType, ObjectStatus, Prisma } from '@prisma/client';

import {
  DeveloperAliases,
  emptyDeveloperAliases,
  normalizeDeveloperName,
  resolveDeveloperName,
} from './developer-aliases';
import {
  ImportIssue,
  MappedDeveloper,
  MappedFile,
  MappedImage,
  MappedImport,
  MappedLocation,
  MappedMetroStation,
  MappedObject,
  WpAttachment,
  WpObjectTerm,
  WpPost,
  WpSourceData,
  WpTerm,
} from './types';

const imageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const pdfMimeType = 'application/pdf';

export function mapWordPressSource(
  source: WpSourceData,
  postType: string,
  dryRun: boolean,
  developerAliases: DeveloperAliases = emptyDeveloperAliases,
) {
  const warnings: ImportIssue[] = [];
  const errors: ImportIssue[] = [];
  const objects = source.objects.map((post) => mapObject(post, source, warnings, errors, developerAliases));

  warnAboutPotentialDeveloperDuplicates(objects, warnings);

  const developers = new Set(objects.map((object) => object.developer?.name).filter(Boolean));
  const locations = new Map<string, MappedLocation>();
  const metroStations = new Map<string, MappedMetroStation>();
  let validImagesMapped = 0;
  let validFilesMapped = 0;

  for (const object of objects) {
    validImagesMapped += object.images.length;
    validFilesMapped += object.files.length;

    for (const location of object.locations) {
      locations.set(`${location.type}:${location.wpTermId}`, location);
    }

    for (const station of object.metroStations) {
      metroStations.set(String(station.wpTermId), station);
    }
  }

  return {
    objects,
    warnings,
    errors,
    summary: {
      source: 'wordpress',
      postType,
      dryRun,
      objectsFound: source.objects.length,
      objectsMapped: objects.length,
      objectsImported: 0,
      objectsCreated: 0,
      objectsUpdated: 0,
      objectsFailed: 0,
      developersMapped: developers.size,
      locationsMapped: locations.size,
      metroStationsMapped: metroStations.size,
      referencedAttachments: source.referencedAttachmentIds.size,
      validImagesMapped,
      validFilesMapped,
      warningsCount: warnings.length,
      errorsCount: errors.length,
    },
  } satisfies MappedImport;
}

function mapObject(
  post: WpPost,
  source: WpSourceData,
  warnings: ImportIssue[],
  errors: ImportIssue[],
  developerAliases: DeveloperAliases,
) {
  const meta = source.metaByPostId.get(post.ID) ?? new Map<string, string[]>();
  const objectTerms = source.termsByObjectId.get(post.ID) ?? [];
  const classifiedTerms = classifyTerms(objectTerms, source);
  const title = firstText(meta, 'zagolovok_1') ?? normalizeText(post.post_title) ?? `WordPress object ${post.ID}`;
  const shortDescription = firstLongText(meta, 'korotkoe_opisanie');
  const description = buildDescription(post, meta, shortDescription);
  const developer = mapDeveloper(firstText(meta, 'imya_zastrojshhika'), developerAliases);
  const coordinates = parseCoordinates(firstText(meta, 'karta_koordinaty'));
  const images = collectImages(meta, source, post.ID, warnings);
  const files = collectFiles(meta, source, post.ID, warnings);
  const primaryLocation = selectPrimaryLocation(classifiedTerms.locations);

  if (!developer) {
    warnings.push({
      severity: 'info',
      code: 'missing_developer',
      message: 'Developer is empty in WordPress meta',
      wpPostId: post.ID,
      metaKey: 'imya_zastrojshhika',
    });
  }

  if (!coordinates) {
    warnings.push({
      severity: 'info',
      code: 'missing_coordinates',
      message: 'Coordinates are empty or invalid',
      wpPostId: post.ID,
      metaKey: 'karta_koordinaty',
    });
  }

  const mappedObject = {
    wpPostId: post.ID,
    title,
    slug: normalizeSlug(post.post_name) ?? `${slugify(title)}-${post.ID}`,
    status: mapObjectStatus(post.post_status),
    description,
    shortDescription,
    priceFrom: parseMoney(firstText(meta, 'stoimost')),
    pricePerMeterFrom: parseMoney(firstText(meta, 'za_m2')),
    completionYear: classifiedTerms.completionYear,
    completionQuarter: classifiedTerms.completionQuarter,
    address: firstLongText(meta, 'adres') ?? firstLongText(meta, 'address'),
    latitude: coordinates?.latitude ?? null,
    longitude: coordinates?.longitude ?? null,
    publishedAt: post.post_status === 'publish' ? parseWpDate(post.post_date) : null,
    developer,
    locations: classifiedTerms.locations,
    primaryLocation,
    metroStations: classifiedTerms.metroStations,
    images,
    files,
    featuresJson: buildFeaturesJson(post, meta, objectTerms, classifiedTerms, source),
  } satisfies MappedObject;

  if (!mappedObject.slug) {
    errors.push({
      severity: 'error',
      code: 'missing_slug',
      message: 'Object slug cannot be generated',
      wpPostId: post.ID,
    });
  }

  return mappedObject;
}

function mapDeveloper(name: string | null, developerAliases: DeveloperAliases): MappedDeveloper | null {
  if (!name) {
    return null;
  }

  const canonicalName = resolveDeveloperName(name, developerAliases);

  return {
    name: canonicalName,
    slug: slugify(canonicalName),
  };
}

function warnAboutPotentialDeveloperDuplicates(objects: MappedObject[], warnings: ImportIssue[]) {
  const namesByNormalizedName = new Map<string, Set<string>>();

  for (const object of objects) {
    if (!object.developer) {
      continue;
    }

    const normalizedName = normalizeDeveloperName(object.developer.name);

    if (!normalizedName) {
      continue;
    }

    const names = namesByNormalizedName.get(normalizedName) ?? new Set<string>();
    names.add(object.developer.name);
    namesByNormalizedName.set(normalizedName, names);
  }

  for (const [normalizedName, names] of namesByNormalizedName.entries()) {
    if (names.size < 2) {
      continue;
    }

    warnings.push({
      severity: 'warning',
      code: 'possible_developer_duplicate',
      message: `Developer names differ only by case or spacing for "${normalizedName}": ${[...names].join(', ')}. Add an explicit group to developer-aliases.json before merging.`,
    });
  }
}

function classifyTerms(objectTerms: WpObjectTerm[], source: WpSourceData) {
  const locations: MappedLocation[] = [];
  const metroStations: MappedMetroStation[] = [];
  let completionYear: number | null = null;
  let completionQuarter: number | null = null;

  for (const term of objectTerms) {
    const path = getTermPath(term, source.termsById);
    const slugs = path.map((pathTerm) => pathTerm.slug);

    if (slugs.includes('rajon-okolo') && term.slug !== 'rajon-okolo') {
      locations.push(mapLocation(term, LocationType.AREA, getParentAfterRoot(path, 'rajon-okolo')));
      continue;
    }

    if (slugs.includes('rajony') && term.slug !== 'rajony') {
      const parentAfterRoot = getParentAfterRoot(path, 'rajony');
      const rootIndex = slugs.indexOf('rajony');
      const depthUnderRoot = rootIndex >= 0 ? path.length - rootIndex - 1 : 0;

      if (depthUnderRoot >= 2 || term.name.trim().length > 2) {
        locations.push(mapLocation(term, LocationType.DISTRICT, parentAfterRoot));
      }

      continue;
    }

    if (slugs.includes('metro') && term.slug !== 'metro') {
      const station = mapMetroStation(term, path, source);

      if (station) {
        metroStations.push(station);
      }

      continue;
    }

    if (slugs.includes('god')) {
      completionYear = parseYear(term.name) ?? completionYear;
      continue;
    }

    if (slugs.includes('sdacha') || slugs.includes('etap-stroitelstva')) {
      completionQuarter = parseQuarter(term.name) ?? completionQuarter;
    }
  }

  return {
    locations: uniqueBy(locations, (location) => `${location.type}:${location.wpTermId}`),
    metroStations: uniqueBy(metroStations, (station) => station.wpTermId),
    completionYear,
    completionQuarter,
  };
}

function mapLocation(term: WpTerm, type: LocationType, parentTerm: WpTerm | null): MappedLocation {
  return {
    wpTermId: term.term_id,
    name: term.name,
    slug: normalizeSlug(term.slug) ?? slugify(term.name),
    type,
    parentWpTermId: parentTerm?.term_id ?? null,
  };
}

function selectPrimaryLocation(locations: MappedLocation[]) {
  const districtLocations = locations.filter((location) => location.type === LocationType.DISTRICT);

  if (districtLocations.length > 0) {
    return districtLocations[districtLocations.length - 1] ?? null;
  }

  return (
    locations.find((location) => location.type === LocationType.AREA) ??
    null
  );
}

function mapMetroStation(term: WpTerm, path: WpTerm[], source: WpSourceData): MappedMetroStation | null {
  const metroRootIndex = path.findIndex((pathTerm) => pathTerm.slug === 'metro');
  const lineTerm = metroRootIndex >= 0 ? path[metroRootIndex + 1] : null;

  if (!lineTerm || lineTerm.term_id === term.term_id) {
    return null;
  }

  const lineMeta = source.termMetaById.get(lineTerm.term_id);

  return {
    wpTermId: term.term_id,
    name: term.name,
    slug: normalizeSlug(term.slug) ?? slugify(term.name),
    lineName: lineTerm.name,
    lineColor: firstMeta(lineMeta, 'czvet_metro'),
  };
}

function collectImages(
  meta: Map<string, string[]>,
  source: WpSourceData,
  wpPostId: number,
  warnings: ImportIssue[],
) {
  const imageRefs: MappedImage[] = [];
  const coverAttachmentId = parseAttachmentId(firstMeta(meta, 'izobrazhenie_miniatyura'));
  const heroAttachmentId = parseAttachmentId(firstMeta(meta, 'izobrazhenie_1'));

  if (coverAttachmentId) {
    addImageRef(imageRefs, {
      attachmentId: coverAttachmentId,
      source,
      wpPostId,
      warnings,
      sortOrder: 0,
      isCover: true,
      sourceMetaKey: 'izobrazhenie_miniatyura',
      alt: null,
      title: null,
    });
  }

  if (heroAttachmentId) {
    addImageRef(imageRefs, {
      attachmentId: heroAttachmentId,
      source,
      wpPostId,
      warnings,
      sortOrder: coverAttachmentId ? 1 : 0,
      isCover: !coverAttachmentId,
      sourceMetaKey: 'izobrazhenie_1',
      alt: null,
      title: null,
    });
  }

  const galleryIndexes = getRepeaterIndexes(meta, /^czikl_vyvoda_galerei_(\d+)_izobrazhenie$/u);
  let nextSortOrder = imageRefs.length;

  for (const index of galleryIndexes) {
    const sourceMetaKey = `czikl_vyvoda_galerei_${index}_izobrazhenie`;
    const attachmentId = parseAttachmentId(firstMeta(meta, sourceMetaKey));

    if (!attachmentId) {
      continue;
    }

    addImageRef(imageRefs, {
      attachmentId,
      source,
      wpPostId,
      warnings,
      sortOrder: nextSortOrder,
      isCover: false,
      sourceMetaKey,
      alt: firstText(meta, `${sourceMetaKey}_alt`),
      title: firstText(meta, `${sourceMetaKey}_title`),
    });
    nextSortOrder += 1;
  }

  return normalizeImageRefs(imageRefs);
}

function addImageRef(
  imageRefs: MappedImage[],
  params: {
    attachmentId: number;
    source: WpSourceData;
    wpPostId: number;
    warnings: ImportIssue[];
    sortOrder: number;
    isCover: boolean;
    sourceMetaKey: string;
    alt: string | null;
    title: string | null;
  },
) {
  const attachment = params.source.attachmentsById.get(params.attachmentId);

  if (!attachment) {
    params.warnings.push({
      severity: 'warning',
      code: 'missing_attachment',
      message: 'Attachment record was not found',
      wpPostId: params.wpPostId,
      wpAttachmentId: params.attachmentId,
      metaKey: params.sourceMetaKey,
    });
    return;
  }

  if (!attachment.mimeType || !imageMimeTypes.has(attachment.mimeType)) {
    params.warnings.push({
      severity: 'warning',
      code: 'invalid_image_mime',
      message: `Attachment MIME type is not supported as image: ${attachment.mimeType ?? 'empty'}`,
      wpPostId: params.wpPostId,
      wpAttachmentId: params.attachmentId,
      metaKey: params.sourceMetaKey,
    });
    return;
  }

  if (!attachment.localExists) {
    params.warnings.push({
      severity: 'warning',
      code: 'missing_local_file',
      message: 'Attachment local file was not found',
      wpPostId: params.wpPostId,
      wpAttachmentId: params.attachmentId,
      metaKey: params.sourceMetaKey,
    });
    return;
  }

  imageRefs.push({
    attachment,
    sortOrder: params.sortOrder,
    isCover: params.isCover,
    alt: params.alt,
    title: params.title,
    sourceMetaKey: params.sourceMetaKey,
  });
}

function collectFiles(
  meta: Map<string, string[]>,
  source: WpSourceData,
  wpPostId: number,
  warnings: ImportIssue[],
) {
  const fileRefs: MappedFile[] = [];
  const presentationAttachmentId = parseAttachmentId(firstMeta(meta, 'pdf_fajl'));

  if (presentationAttachmentId) {
    addFileRef(fileRefs, {
      attachmentId: presentationAttachmentId,
      type: ObjectFileType.PRESENTATION,
      title: 'Презентация',
      sortOrder: 0,
      sourceMetaKey: 'pdf_fajl',
      source,
      wpPostId,
      warnings,
    });
  }

  const seenAttachmentIds = new Set(fileRefs.map((file) => file.attachment.ID));
  let sortOrder = fileRefs.length;

  for (const [key, values] of meta.entries()) {
    if (!/(?:fajl|pdf|plan)/iu.test(key) || key === 'pdf_fajl') {
      continue;
    }

    const attachmentId = parseAttachmentId(values[0]);

    if (!attachmentId || seenAttachmentIds.has(attachmentId)) {
      continue;
    }

    addFileRef(fileRefs, {
      attachmentId,
      type: key.includes('komnat') || key.includes('plan') ? ObjectFileType.FLOOR_PLAN : ObjectFileType.OTHER,
      title: null,
      sortOrder,
      sourceMetaKey: key,
      source,
      wpPostId,
      warnings,
    });
    seenAttachmentIds.add(attachmentId);
    sortOrder += 1;
  }

  return fileRefs;
}

function addFileRef(
  fileRefs: MappedFile[],
  params: {
    attachmentId: number;
    type: ObjectFileType;
    title: string | null;
    sortOrder: number;
    sourceMetaKey: string;
    source: WpSourceData;
    wpPostId: number;
    warnings: ImportIssue[];
  },
) {
  const attachment = params.source.attachmentsById.get(params.attachmentId);

  if (!attachment) {
    params.warnings.push({
      severity: 'warning',
      code: 'missing_attachment',
      message: 'Attachment record was not found',
      wpPostId: params.wpPostId,
      wpAttachmentId: params.attachmentId,
      metaKey: params.sourceMetaKey,
    });
    return;
  }

  if (attachment.mimeType !== pdfMimeType) {
    params.warnings.push({
      severity: 'warning',
      code: 'invalid_file_mime',
      message: `Attachment MIME type is not supported as PDF: ${attachment.mimeType ?? 'empty'}`,
      wpPostId: params.wpPostId,
      wpAttachmentId: params.attachmentId,
      metaKey: params.sourceMetaKey,
    });
    return;
  }

  if (!attachment.localExists) {
    params.warnings.push({
      severity: 'warning',
      code: 'missing_local_file',
      message: 'Attachment local file was not found',
      wpPostId: params.wpPostId,
      wpAttachmentId: params.attachmentId,
      metaKey: params.sourceMetaKey,
    });
    return;
  }

  fileRefs.push({
    attachment,
    type: params.type,
    title: params.title,
    sortOrder: params.sortOrder,
    sourceMetaKey: params.sourceMetaKey,
  });
}

function normalizeImageRefs(imageRefs: MappedImage[]) {
  const byAttachmentId = new Map<number, MappedImage>();

  for (const image of imageRefs) {
    const existingImage = byAttachmentId.get(image.attachment.ID);

    if (!existingImage) {
      byAttachmentId.set(image.attachment.ID, image);
      continue;
    }

    if (image.isCover && !existingImage.isCover) {
      byAttachmentId.set(image.attachment.ID, {
        ...existingImage,
        isCover: true,
        sortOrder: Math.min(existingImage.sortOrder, image.sortOrder),
        sourceMetaKey: image.sourceMetaKey,
      });
    }
  }

  return [...byAttachmentId.values()]
    .sort((first, second) => first.sortOrder - second.sortOrder)
    .map((image, index) => ({
      ...image,
      sortOrder: index,
      isCover: image.isCover || index === 0,
    }));
}

function buildFeaturesJson(
  post: WpPost,
  meta: Map<string, string[]>,
  objectTerms: WpObjectTerm[],
  classifiedTerms: ReturnType<typeof classifyTerms>,
  source: WpSourceData,
) {
  const groupedTerms = groupFeatureTerms(objectTerms, source);

  return compactJson({
    wp: {
      postId: post.ID,
      postStatus: post.post_status,
      postDate: post.post_date,
      postModified: post.post_modified,
      sourceUrl: source.siteUrl && post.post_name ? `${source.siteUrl.replace(/\/+$/u, '')}/${post.post_name}/` : null,
    },
    h1: firstText(meta, 'zagolovok_1'),
    shortDescription: firstLongText(meta, 'korotkoe_opisanie'),
    optionalPrice: parseBoolean(firstMeta(meta, 'czena_opczionalna')),
    roomPrices: compactJson({
      studio: parseMoney(firstText(meta, 'stoimost_1')),
      oneRoom: parseMoney(firstText(meta, 'stoimost_2')),
      twoRoom: parseMoney(firstText(meta, 'stoimost_3')),
      threeRoom: parseMoney(firstText(meta, 'stoimost_4')),
      fourPlusRoom: parseMoney(firstText(meta, 'stoimost_5')),
    }),
    textSections: [
      firstLongText(meta, 'opisanie_2'),
      firstLongText(meta, 'opisanie_3'),
      firstLongText(meta, 'opisanie_4_1'),
      firstLongText(meta, 'opisanie_4_2'),
      firstLongText(meta, 'opisanie_5'),
    ].filter(Boolean),
    characteristics: collectRepeater(meta, 'czikl_vyvoda_czen'),
    rooms: collectRepeater(meta, 'czikl_vyvoda_komnat'),
    tabs: collectRepeater(meta, 'czikl_vyvoda_tabov'),
    nearbyPlaces: collectRepeater(meta, 'czikl_vyvoda_mest_ryadom'),
    relatedWpPostIds: parseRelatedWpPostIds(firstMeta(meta, 'pohozhie_zhilye_kompleksy')),
    taxonomy: groupedTerms,
    locationWpTermIds: classifiedTerms.locations.map((location) => location.wpTermId),
    metroWpTermIds: classifiedTerms.metroStations.map((station) => station.wpTermId),
  }) as Prisma.InputJsonObject;
}

function groupFeatureTerms(objectTerms: WpObjectTerm[], source: WpSourceData) {
  const groups: Record<string, string[]> = {};

  for (const term of objectTerms) {
    const path = getTermPath(term, source.termsById);
    const rootTerm = path.find((pathTerm) => pathTerm.parent === 0) ?? path[0];
    const key = rootTerm?.slug || term.taxonomy;

    if (!groups[key]) {
      groups[key] = [];
    }

    groups[key].push(term.name);
  }

  return groups;
}

function buildDescription(post: WpPost, meta: Map<string, string[]>, shortDescription: string | null) {
  const contentSections = [
    firstLongText(meta, 'opisanie_2'),
    firstLongText(meta, 'opisanie_3'),
    firstLongText(meta, 'opisanie_4_1'),
    firstLongText(meta, 'opisanie_4_2'),
    firstLongText(meta, 'opisanie_5'),
  ].filter(Boolean);

  if (contentSections.length > 0) {
    return contentSections.join('\n\n');
  }

  return normalizeText(stripHtml(post.post_content)) ?? shortDescription;
}

function collectRepeater(meta: Map<string, string[]>, prefix: string) {
  const rows = new Map<number, Record<string, string>>();
  const pattern = new RegExp(`^${escapeRegExp(prefix)}_(\\d+)_(.+)$`, 'u');

  for (const [key, values] of meta.entries()) {
    const match = key.match(pattern);

    if (!match) {
      continue;
    }

    const index = Number(match[1]);
    const fieldName = match[2];

    if (!Number.isInteger(index) || !fieldName || fieldName.startsWith('_')) {
      continue;
    }

    const row = rows.get(index) ?? {};
    row[fieldName] = normalizeText(values[0]) ?? '';
    rows.set(index, row);
  }

  return [...rows.entries()]
    .sort(([firstIndex], [secondIndex]) => firstIndex - secondIndex)
    .map(([, row]) => compactJson(row))
    .filter((row) => Object.keys(row).length > 0);
}

function getRepeaterIndexes(meta: Map<string, string[]>, pattern: RegExp) {
  const indexes = new Set<number>();

  for (const key of meta.keys()) {
    const match = key.match(pattern);
    const index = match?.[1] ? Number(match[1]) : null;

    if (index !== null && Number.isInteger(index)) {
      indexes.add(index);
    }
  }

  return [...indexes].sort((first, second) => first - second);
}

function getTermPath(term: WpTerm, termsById: Map<number, WpTerm>) {
  const path: WpTerm[] = [term];
  const visited = new Set<number>([term.term_id]);
  let parentId = term.parent;

  while (parentId > 0 && !visited.has(parentId)) {
    const parent = termsById.get(parentId);

    if (!parent) {
      break;
    }

    path.unshift(parent);
    visited.add(parent.term_id);
    parentId = parent.parent;
  }

  return path;
}

function getParentAfterRoot(path: WpTerm[], rootSlug: string) {
  const rootIndex = path.findIndex((term) => term.slug === rootSlug);

  if (rootIndex < 0) {
    return null;
  }

  return path[rootIndex + 1] ?? null;
}

function firstText(meta: Map<string, string[]> | undefined, key: string) {
  return normalizeText(firstMeta(meta, key));
}

function firstLongText(meta: Map<string, string[]> | undefined, key: string) {
  return normalizeText(stripHtml(firstMeta(meta, key)));
}

function firstMeta(meta: Map<string, string[]> | undefined, key: string) {
  return meta?.get(key)?.find((value) => value.trim().length > 0)?.trim() ?? null;
}

function parseAttachmentId(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  if (!/^\d+$/u.test(value.trim())) {
    return null;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseMoney(value: string | null) {
  if (!value) {
    return null;
  }

  const normalizedValue = value.replace(/[^\d.,]/gu, '').replace(',', '.');

  if (!normalizedValue || !/^\d+(\.\d+)?$/u.test(normalizedValue)) {
    return null;
  }

  return trimDecimal(normalizedValue);
}

function parseCoordinates(value: string | null) {
  if (!value) {
    return null;
  }

  const [rawLatitude, rawLongitude] = value.split(',').map((part) => part?.trim().replace(/\s+/gu, ''));

  if (!rawLatitude || !rawLongitude) {
    return null;
  }

  const latitude = parseCoordinate(rawLatitude, -90, 90);
  const longitude = parseCoordinate(rawLongitude, -180, 180);

  if (!latitude || !longitude) {
    return null;
  }

  return {
    latitude,
    longitude,
  };
}

function parseCoordinate(value: string, min: number, max: number) {
  const normalizedValue = value.replace(',', '.');

  if (!/^-?\d+(\.\d+)?$/u.test(normalizedValue)) {
    return null;
  }

  const parsed = Number(normalizedValue);

  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return null;
  }

  return Number(parsed.toFixed(6)).toString();
}

function parseYear(value: string) {
  const match = value.match(/\b(19\d{2}|20\d{2}|21\d{2})\b/u);

  return match?.[1] ? Number(match[1]) : null;
}

function parseQuarter(value: string) {
  const match = value.match(/\b([1-4])\s*(?:кв|q|quarter)/iu);

  return match?.[1] ? Number(match[1]) : null;
}

function parseBoolean(value: string | null) {
  if (!value) {
    return null;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseRelatedWpPostIds(value: string | null) {
  if (!value) {
    return [];
  }

  const ids = [...value.matchAll(/s:\d+:"(\d+)"/gu)]
    .map((match) => Number(match[1]))
    .filter((id) => Number.isSafeInteger(id) && id > 0);

  if (ids.length > 0) {
    return uniqueBy(ids, (id) => id);
  }

  return value
    .split(/[,\s]+/u)
    .map((item) => Number(item))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

function mapObjectStatus(status: string) {
  return status === 'publish' ? ObjectStatus.PUBLISHED : ObjectStatus.DRAFT;
}

function parseWpDate(value: string | null) {
  if (!value || value.startsWith('0000-00-00')) {
    return null;
  }

  const date = new Date(`${value.replace(' ', 'T')}Z`);

  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeSlug(value: string | null | undefined) {
  const slug = value
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-');

  return slug || null;
}

export function slugify(value: string) {
  const transliterationMap: Record<string, string> = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'e',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'h',
    ц: 'ts',
    ч: 'ch',
    ш: 'sh',
    щ: 'sch',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya',
  };
  const transliterated = value
    .trim()
    .toLowerCase()
    .split('')
    .map((character) => transliterationMap[character] ?? character)
    .join('');
  const slug = transliterated
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-')
    .slice(0, 120)
    .replace(/-+$/gu, '');

  return slug || 'item';
}

function stripHtml(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  return value
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/p>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/&nbsp;/giu, ' ')
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#039;/giu, "'");
}

function normalizeText(value: string | null | undefined) {
  const normalizedValue = value?.replace(/\s+/gu, ' ').trim();

  return normalizedValue || null;
}

function trimDecimal(value: string) {
  const trimmedValue = value.replace(/^0+(\d)/u, '$1');
  const result = trimmedValue.includes('.')
    ? trimmedValue.replace(/(\.\d*?[1-9])0+$/u, '$1').replace(/\.0+$/u, '')
    : trimmedValue;

  return result || '0';
}

function compactJson(value: Record<string, unknown>) {
  const result: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) {
      continue;
    }

    if (Array.isArray(item) && item.length === 0) {
      continue;
    }

    if (typeof item === 'object' && !Array.isArray(item) && Object.keys(item).length === 0) {
      continue;
    }

    result[key] = item;
  }

  return result;
}

function uniqueBy<T, K>(items: T[], getKey: (item: T) => K) {
  const seen = new Set<K>();
  const result: T[] = [];

  for (const item of items) {
    const key = getKey(item);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(item);
  }

  return result;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
