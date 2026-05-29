import type { ObjectDeveloper, RealEstateObjectDetail, RealEstateObjectSummary } from '@platforma/shared';

import type {
  ObjectQuickEditCellValue,
  ObjectQuickEditColumnKey,
} from './ObjectQuickEditTable';
import type { QuickEditCompletionValue } from './objectQuickEditTransforms';

type CoordinateParseResult = {
  latitude: string | null;
  longitude: string | null;
  error: string | null;
};

type ObjectQuickEditRequestParams = {
  objectId: string;
  columnKey: ObjectQuickEditColumnKey;
  value: ObjectQuickEditCellValue;
  developers: ObjectDeveloper[];
  parseCoordinates: (value: string) => CoordinateParseResult;
};

type ObjectQuickEditRequest = {
  method: 'PATCH';
  path: string;
  payload: Record<string, unknown>;
};

const textPayloadColumns = new Set<ObjectQuickEditColumnKey>([
  'title',
  'priceFrom',
  'pricePerMeterFrom',
  'krtName',
  'propertyClass',
  'apartmentsCountText',
  'apartmentAreaRange',
  'ceilingHeight',
  'floorRange',
  'mapName',
]);

export function createObjectQuickEditRequest({
  objectId,
  columnKey,
  value,
  developers,
  parseCoordinates,
}: ObjectQuickEditRequestParams): ObjectQuickEditRequest {
  if (columnKey === 'status') {
    return {
      method: 'PATCH',
      path: `/objects/${objectId}/status`,
      payload: { status: value },
    };
  }

  if (columnKey === 'metro') {
    return {
      method: 'PATCH',
      path: `/objects/${objectId}`,
      payload: { metroStationIds: Array.isArray(value) ? value : [] },
    };
  }

  if (columnKey === 'developer') {
    return {
      method: 'PATCH',
      path: `/objects/${objectId}`,
      payload: { developerId: getDeveloperIdForQuickEditValue(developers, value) },
    };
  }

  if (columnKey === 'completion') {
    const completion = getQuickEditCompletionValue(value);

    return {
      method: 'PATCH',
      path: `/objects/${objectId}`,
      payload: {
        completionQuarter: completion.completionQuarter,
        completionYear: completion.completionYear,
      },
    };
  }

  if (columnKey === 'coordinates') {
    const coordinates = parseCoordinates(getStringQuickEditValue(value));

    if (coordinates.error) {
      throw new Error(coordinates.error);
    }

    return {
      method: 'PATCH',
      path: `/objects/${objectId}`,
      payload: { latitude: coordinates.latitude, longitude: coordinates.longitude },
    };
  }

  if (textPayloadColumns.has(columnKey)) {
    return {
      method: 'PATCH',
      path: `/objects/${objectId}`,
      payload: { [columnKey]: emptyToNull(getStringQuickEditValue(value)) },
    };
  }

  throw new Error('Эту ячейку пока нельзя сохранить из быстрой таблицы');
}

export function updateObjectQuickEditRows(
  objects: RealEstateObjectSummary[],
  updatedObject: RealEstateObjectDetail,
  statusFilter: string,
) {
  if (shouldRemoveObjectQuickEditRow(objects, updatedObject, statusFilter)) {
    return objects.filter((object) => object.id !== updatedObject.id);
  }

  return objects.map((object) =>
    object.id === updatedObject.id ? mergeObjectQuickEditRow(object, updatedObject) : object,
  );
}

export function shouldRemoveObjectQuickEditRow(
  objects: Array<Pick<RealEstateObjectSummary, 'id'>>,
  updatedObject: Pick<RealEstateObjectDetail, 'id' | 'status'>,
  statusFilter: string,
) {
  return Boolean(statusFilter && updatedObject.status !== statusFilter && objects.some((object) => object.id === updatedObject.id));
}

function mergeObjectQuickEditRow(
  currentObject: RealEstateObjectSummary,
  updatedObject: RealEstateObjectDetail,
): RealEstateObjectSummary {
  const coverImage = updatedObject.images.find((image) => image.isCover) ?? updatedObject.images[0] ?? null;
  const presentationFile = updatedObject.files.find((file) => file.type === 'PRESENTATION') ?? null;

  return {
    ...currentObject,
    ...updatedObject,
    coverImage,
    presentationFile,
  };
}

function getDeveloperIdForQuickEditValue(developers: ObjectDeveloper[], value: ObjectQuickEditCellValue) {
  const normalizedValue = normalizeQuickEditPersistenceTerm(getStringQuickEditValue(value));

  if (!normalizedValue) {
    return null;
  }

  const developer = developers.find((item) =>
    [item.name, item.slug].some((candidate) => normalizeQuickEditPersistenceTerm(candidate ?? '') === normalizedValue),
  );

  if (!developer) {
    throw new Error('Выберите застройщика из списка');
  }

  return developer.id;
}

function normalizeQuickEditPersistenceTerm(value: string) {
  return value.replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getQuickEditCompletionValue(value: ObjectQuickEditCellValue): QuickEditCompletionValue {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value;
  }

  throw new Error('Срок сдачи нужно указать в формате: 2 кв 2029');
}

function getStringQuickEditValue(value: ObjectQuickEditCellValue) {
  return typeof value === 'string' ? value : '';
}

function emptyToNull(value: string) {
  const trimmedValue = value.trim();

  return trimmedValue ? trimmedValue : null;
}
