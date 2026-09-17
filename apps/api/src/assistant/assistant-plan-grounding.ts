import type { AssistantSearchFilters } from './assistant-query-planner';

const filterKeys = [
  'budgetMinRub',
  'budgetMaxRub',
  'rooms',
  'district',
  'metro',
  'developer',
  'completionYearMin',
  'completionYearMax',
  'completionQuarter',
  'objectType',
  'propertyClass',
  'areaMin',
  'areaMax',
  'floorMin',
  'floorMax',
] as const;

export function assistantFiltersHaveConflict(filters: Partial<AssistantSearchFilters>) {
  return [
    [filters.budgetMinRub, filters.budgetMaxRub],
    [filters.completionYearMin, filters.completionYearMax],
    [filters.areaMin, filters.areaMax],
    [filters.floorMin, filters.floorMax],
  ].some(([minimum, maximum]) => typeof minimum === 'number'
    && typeof maximum === 'number' && minimum > maximum);
}

// A provider-assigned filter value is grounded only when the deterministic extractors
// read the same value from the dialog or the page context. Anything else is dropped so
// the merge below falls back to the extracted values instead of an invented one.
export function dropUngroundedPlannerFilterValues(
  filters: AssistantSearchFilters,
  explicitFilters: Partial<AssistantSearchFilters>,
  contextFilters: Partial<AssistantSearchFilters>,
): AssistantSearchFilters {
  const result = { ...filters, rooms: [...filters.rooms] };
  for (const key of filterKeys) {
    const value = filters[key];
    if (!filterHasSignal(key, value)) continue;
    if (filterValuesEqual(value, explicitFilters[key])
      || filterValuesEqual(value, contextFilters[key])) continue;
    assignFilterValue(result, key, key === 'rooms' ? [] : key === 'objectType' ? 'RESIDENTIAL' : null);
  }
  return result;
}

export function omitProviderAssignedFilters(
  explicitFilters: Partial<AssistantSearchFilters>,
  hardFilters: AssistantSearchFilters,
  softPreferences: AssistantSearchFilters,
) {
  const result: Partial<AssistantSearchFilters> = {};
  for (const key of filterKeys) {
    const value = explicitFilters[key];
    if (value === undefined) continue;
    if (filterHasSignal(key, hardFilters[key]) || filterHasSignal(key, softPreferences[key])) continue;
    assignFilterValue(result, key, value);
  }
  return result;
}

export function removeHardFilterOverlaps(
  softPreferences: AssistantSearchFilters,
  hardFilters: AssistantSearchFilters,
): AssistantSearchFilters {
  const result = { ...softPreferences, rooms: [...softPreferences.rooms] };
  for (const key of filterKeys) {
    if (!filterHasSignal(key, hardFilters[key])
      || !filterValuesEqual(softPreferences[key], hardFilters[key])) continue;
    assignFilterValue(result, key, key === 'rooms' ? [] : key === 'objectType' ? 'RESIDENTIAL' : null);
  }
  return result;
}

function assignFilterValue<Key extends keyof AssistantSearchFilters>(
  filters: Partial<AssistantSearchFilters>,
  key: Key,
  value: AssistantSearchFilters[Key],
) {
  (filters as Record<Key, AssistantSearchFilters[Key]>)[key] = value;
}

function filterHasSignal<Key extends keyof AssistantSearchFilters>(
  key: Key,
  value: AssistantSearchFilters[Key],
) {
  if (key === 'rooms') return Array.isArray(value) && value.length > 0;
  if (key === 'objectType') return value === 'COMMERCIAL';
  return value !== null;
}

function filterValuesEqual(left: unknown, right: unknown) {
  return Array.isArray(left) && Array.isArray(right)
    ? JSON.stringify(left) === JSON.stringify(right)
    : left === right;
}
