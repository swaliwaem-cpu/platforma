import { useMemo, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, PencilIcon } from 'lucide-react';
import {
  ObjectDeveloper,
  ObjectMetroStation,
  ObjectStatus,
  RealEstateObjectSummary,
} from '@platforma/shared';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { AdminButton, AdminEmptyState, AdminStatusBadge } from './AdminUi';
import {
  matchesQuickEditSearch,
  normalizeApartmentAreaRange,
  parseQuickEditCompletion,
  type QuickEditCompletionValue,
} from './objectQuickEditTransforms';

export type SortField = 'createdAt' | 'updatedAt' | 'title' | 'status' | 'priceFrom' | 'pricePerMeterFrom' | 'completionYear';
export type SortDirection = 'asc' | 'desc';
export type ObjectQuickEditColumnKey =
  | 'title'
  | 'status'
  | 'priceFrom'
  | 'pricePerMeterFrom'
  | 'developer'
  | 'krtName'
  | 'completion'
  | 'metro'
  | 'propertyClass'
  | 'apartmentsCountText'
  | 'apartmentAreaRange'
  | 'ceilingHeight'
  | 'floorRange'
  | 'coordinates';
export type ObjectQuickEditCellValue = string | string[] | ObjectStatus | QuickEditCompletionValue;

type ObjectQuickEditEditor = 'text' | 'status' | 'class' | 'developer' | 'metro';

type ObjectQuickEditColumn = {
  key: ObjectQuickEditColumnKey;
  label: string;
  editor: ObjectQuickEditEditor;
  sortField?: SortField;
};

export const objectQuickEditColumns = [
  { key: 'title', label: 'Название', editor: 'text', sortField: 'title' },
  { key: 'status', label: 'Статус', editor: 'status', sortField: 'status' },
  { key: 'priceFrom', label: 'Цена от', editor: 'text', sortField: 'priceFrom' },
  { key: 'pricePerMeterFrom', label: 'За метр от', editor: 'text', sortField: 'pricePerMeterFrom' },
  { key: 'developer', label: 'Застройщик', editor: 'developer' },
  { key: 'krtName', label: 'КРТ', editor: 'text' },
  { key: 'completion', label: 'Срок сдачи', editor: 'text', sortField: 'completionYear' },
  { key: 'metro', label: 'Метро', editor: 'metro' },
  { key: 'propertyClass', label: 'Класс', editor: 'class' },
  { key: 'apartmentsCountText', label: 'Количество квартир', editor: 'text' },
  { key: 'apartmentAreaRange', label: 'Площадь квартир', editor: 'text' },
  { key: 'ceilingHeight', label: 'Высота потолков', editor: 'text' },
  { key: 'floorRange', label: 'Этажность', editor: 'text' },
  { key: 'coordinates', label: 'Координаты', editor: 'text' },
] as const satisfies readonly ObjectQuickEditColumn[];

export const objectStatusLabels: Record<ObjectStatus, string> = {
  DRAFT: 'Черновик',
  PUBLISHED: 'Опубликован',
  ARCHIVED: 'Архив',
};

const statusQuickEditOptions = [
  { value: 'PUBLISHED', label: 'Опубликован' },
  { value: 'ARCHIVED', label: 'Архив' },
] satisfies Array<{ value: Exclude<ObjectStatus, 'DRAFT'>; label: string }>;

const propertyClassOptions = [
  'Комфорт-класс',
  'Бизнес-класс',
  'Премиум-класс',
  'Делюкс',
] as const;

type ObjectQuickEditTableProps = {
  developers: ObjectDeveloper[];
  hasActiveListFilters: boolean;
  isLoading: boolean;
  metroStations: ObjectMetroStation[];
  objects: RealEstateObjectSummary[];
  sortBy: SortField;
  sortDirection: SortDirection;
  onInlineEditCommit?: (params: {
    objectId: string;
    columnKey: ObjectQuickEditColumnKey;
    value: ObjectQuickEditCellValue;
  }) => void | Promise<void>;
  onOpenObject: (objectId: string) => void;
  onSort: (sortField: SortField) => void;
};

type EditingCell = {
  objectId: string;
  columnKey: ObjectQuickEditColumnKey;
};

type ObjectWithMetroStations = {
  metroStations: Array<Pick<ObjectMetroStation, 'id' | 'lineName' | 'name'>>;
};

export function ObjectQuickEditTable({
  developers,
  hasActiveListFilters,
  isLoading,
  metroStations,
  objects,
  sortBy,
  sortDirection,
  onInlineEditCommit,
  onOpenObject,
  onSort,
}: ObjectQuickEditTableProps) {
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [editingError, setEditingError] = useState<string | null>(null);

  function startEditing(objectId: string, column: ObjectQuickEditColumn) {
    setEditingError(null);
    setEditingCell({ objectId, columnKey: column.key });
  }

  function closeEditor() {
    setEditingError(null);
    setEditingCell(null);
  }

  async function commitInlineEdit(objectId: string, columnKey: ObjectQuickEditColumnKey, value: ObjectQuickEditCellValue) {
    setEditingError(null);

    try {
      await onInlineEditCommit?.({ objectId, columnKey, value });
      closeEditor();
    } catch (caughtError) {
      setEditingError(caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить ячейку');
    }
  }

  return (
    <Table className="admin-table compact-table object-quick-edit-table">
      <TableHeader>
        <TableRow>
          {objectQuickEditColumns.map((column) => {
            const sortField = 'sortField' in column ? column.sortField : undefined;

            return (
              <TableHead
                key={column.key}
                aria-sort={sortField ? getSortAria(sortBy, sortDirection, sortField) : undefined}
                className={`object-quick-column object-quick-column--${column.key}`}
              >
                {sortField ? (
                  <SortButton
                    active={sortBy === sortField}
                    direction={sortDirection}
                    onClick={() => onSort(sortField)}
                  >
                    {column.label}
                  </SortButton>
                ) : (
                  column.label
                )}
              </TableHead>
            );
          })}
        </TableRow>
      </TableHeader>
      <TableBody>
        {objects.map((item) => (
          <TableRow key={item.id}>
            {objectQuickEditColumns.map((column) => (
              <TableCell
                key={column.key}
                className={`object-quick-cell object-quick-cell--${column.key}`}
              >
                {renderQuickEditCell({
                  column,
                  developers,
                  editingError: editingCell?.objectId === item.id && editingCell.columnKey === column.key ? editingError : null,
                  isEditing: editingCell?.objectId === item.id && editingCell.columnKey === column.key,
                  item,
                  metroStations,
                  onCancel: closeEditor,
                  onCommit: (value) => void commitInlineEdit(item.id, column.key, value),
                  onOpenObject,
                  onStartEditing: () => startEditing(item.id, column),
                })}
              </TableCell>
            ))}
          </TableRow>
        ))}

        {!isLoading && objects.length === 0 ? (
          <TableRow>
            <TableCell colSpan={objectQuickEditColumns.length}>
              <AdminEmptyState
                title="Объекты не найдены"
                description={
                  hasActiveListFilters
                    ? 'Сбросьте фильтры или измените поисковый запрос.'
                    : 'Создайте первый объект, чтобы он появился в списке.'
                }
              />
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  );
}

function renderQuickEditCell({
  column,
  developers,
  editingError,
  isEditing,
  item,
  metroStations,
  onCancel,
  onCommit,
  onOpenObject,
  onStartEditing,
}: {
  column: ObjectQuickEditColumn;
  developers: ObjectDeveloper[];
  editingError: string | null;
  isEditing: boolean;
  item: RealEstateObjectSummary;
  metroStations: ObjectMetroStation[];
  onCancel: () => void;
  onCommit: (value: ObjectQuickEditCellValue) => void;
  onOpenObject: (objectId: string) => void;
  onStartEditing: () => void;
}) {
  if (column.key === 'title') {
    if (isEditing) {
      return (
        <div className="quick-edit-editor quick-edit-editor--title">
          <EditableTextCell
            value={getCellDraftValue(item, column.key)}
            onCancel={onCancel}
            onCommit={(value) => onCommit(getTextCellCommitValue(column.key, value))}
          />
          {editingError ? <p className="quick-edit-error" role="alert">{editingError}</p> : null}
        </div>
      );
    }

    return (
      <div className="object-title-cell">
        <button className="object-title-open" type="button" onClick={() => onOpenObject(item.id)}>
          <strong>{item.title}</strong>
        </button>
        <button
          aria-label={`Редактировать название: ${item.title}`}
          className="object-title-edit-button"
          type="button"
          onClick={onStartEditing}
        >
          <PencilIcon aria-hidden="true" />
        </button>
      </div>
    );
  }

  if (isEditing) {
    let editor;

    if (column.editor === 'status') {
      editor = <StatusSelectEditor value={item.status} onCancel={onCancel} onCommit={onCommit} />;
    } else if (column.editor === 'class') {
      editor = <PropertyClassSelectEditor value={item.propertyClass ?? ''} onCancel={onCancel} onCommit={onCommit} />;
    } else if (column.editor === 'developer') {
      editor = (
        <DeveloperSearchEditor
          developers={developers}
          value={item.developer?.name ?? ''}
          onCancel={onCancel}
          onCommit={onCommit}
        />
      );
    } else if (column.editor === 'metro') {
      editor = (
        <MetroMultiSelectEditor
          metroStations={metroStations}
          selectedStationIds={item.metroStations.map((station) => station.id)}
          onCancel={onCancel}
          onCommit={onCommit}
        />
      );
    } else {
      editor = (
        <EditableTextCell
          value={getCellDraftValue(item, column.key)}
          onCancel={onCancel}
          onCommit={(value) => onCommit(getTextCellCommitValue(column.key, value))}
        />
      );
    }

    return (
      <div className="quick-edit-editor">
        {editor}
        {editingError ? <p className="quick-edit-error" role="alert">{editingError}</p> : null}
      </div>
    );
  }

  const displayValue = getCellDisplayValue(item, column.key);
  const isMuted = displayValue === null;

  return (
    <button
      className={isMuted ? 'quick-edit-cell-button quick-edit-cell-button--empty' : 'quick-edit-cell-button'}
      type="button"
      onClick={onStartEditing}
    >
      {column.key === 'status' ? (
        <AdminStatusBadge className={`object-status object-status--${item.status.toLowerCase()}`}>
          {objectStatusLabels[item.status]}
        </AdminStatusBadge>
      ) : (
        displayValue ?? '—'
      )}
    </button>
  );
}

function EditableTextCell({
  value,
  onCancel,
  onCommit,
}: {
  value: string;
  onCancel: () => void;
  onCommit: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);

  function handleEditorKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      onCommit(draftValue);
    }

    if (event.key === 'Escape') {
      onCancel();
    }
  }

  function handleEditorBlur() {
    onCommit(draftValue);
  }

  return (
    <input
      autoFocus
      className="quick-edit-input"
      type="text"
      value={draftValue}
      onBlur={handleEditorBlur}
      onChange={(event) => setDraftValue(event.currentTarget.value)}
      onKeyDown={handleEditorKeyDown}
    />
  );
}

function StatusSelectEditor({
  value,
  onCancel,
  onCommit,
}: {
  value: ObjectStatus;
  onCancel: () => void;
  onCommit: (value: ObjectStatus) => void;
}) {
  const [draftValue, setDraftValue] = useState<ObjectStatus | ''>(value === 'DRAFT' ? '' : value);

  function handleEditorKeyDown(event: KeyboardEvent<HTMLSelectElement>) {
    if (event.key === 'Enter' && draftValue) {
      onCommit(draftValue);
    }

    if (event.key === 'Escape') {
      onCancel();
    }
  }

  function handleEditorBlur() {
    if (draftValue) {
      onCommit(draftValue);
      return;
    }

    onCancel();
  }

  return (
    <select
      autoFocus
      className="quick-edit-select"
      value={draftValue}
      onBlur={handleEditorBlur}
      onChange={(event) => setDraftValue(event.currentTarget.value as ObjectStatus)}
      onKeyDown={handleEditorKeyDown}
    >
      <option disabled value="">
        Выберите статус
      </option>
      {statusQuickEditOptions.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function PropertyClassSelectEditor({
  value,
  onCancel,
  onCommit,
}: {
  value: string;
  onCancel: () => void;
  onCommit: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);

  function handleEditorKeyDown(event: KeyboardEvent<HTMLSelectElement>) {
    if (event.key === 'Enter') {
      onCommit(draftValue);
    }

    if (event.key === 'Escape') {
      onCancel();
    }
  }

  function handleEditorBlur() {
    onCommit(draftValue);
  }

  return (
    <select
      autoFocus
      className="quick-edit-select"
      value={draftValue}
      onBlur={handleEditorBlur}
      onChange={(event) => setDraftValue(event.currentTarget.value)}
      onKeyDown={handleEditorKeyDown}
    >
      <option value="">Не указан</option>
      {propertyClassOptions.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

function DeveloperSearchEditor({
  developers,
  value,
  onCancel,
  onCommit,
}: {
  developers: ObjectDeveloper[];
  value: string;
  onCancel: () => void;
  onCommit: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);
  const datalistId = 'quick-edit-developer-options';
  const filteredDevelopers = useMemo(
    () => developers.filter((developer) => matchesQuickEditSearch(draftValue, [developer.name, developer.slug])),
    [developers, draftValue],
  );

  function handleEditorKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      onCommit(draftValue);
    }

    if (event.key === 'Escape') {
      onCancel();
    }
  }

  function handleEditorBlur() {
    onCommit(draftValue);
  }

  return (
    <>
      <input
        autoFocus
        className="quick-edit-input"
        list={datalistId}
        placeholder="Поиск застройщика"
        type="search"
        value={draftValue}
        onBlur={handleEditorBlur}
        onChange={(event) => setDraftValue(event.currentTarget.value)}
        onKeyDown={handleEditorKeyDown}
      />
      <datalist id={datalistId}>
        {filteredDevelopers.map((developer) => (
          <option key={developer.id} label={developer.slug ?? ''} value={developer.name} />
        ))}
      </datalist>
    </>
  );
}

function MetroMultiSelectEditor({
  metroStations,
  selectedStationIds,
  onCancel,
  onCommit,
}: {
  metroStations: ObjectMetroStation[];
  selectedStationIds: string[];
  onCancel: () => void;
  onCommit: (value: string[]) => void;
}) {
  const [draftIds, setDraftIds] = useState(selectedStationIds);
  const [query, setQuery] = useState('');
  const metroStationById = useMemo(() => new Map(metroStations.map((station) => [station.id, station])), [metroStations]);
  const filteredStations = useMemo(() => {
    return metroStations.filter((station) => matchesQuickEditSearch(query, [station.name, station.slug, station.lineName]));
  }, [metroStations, query]);

  function handleEditorKeyDown(event: KeyboardEvent<HTMLInputElement | HTMLSelectElement>) {
    if (event.key === 'Enter') {
      onCommit(draftIds);
    }

    if (event.key === 'Escape') {
      onCancel();
    }
  }

  function handleEditorBlur(event: FocusEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    onCommit(draftIds);
  }

  return (
    <div className="quick-edit-metro-editor" onBlur={handleEditorBlur}>
      <input
        autoFocus
        className="quick-edit-input"
        placeholder="Поиск метро"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={handleEditorKeyDown}
      />
      {draftIds.length > 0 ? (
        <div className="quick-edit-metro-selected">
          {draftIds.map((stationId) => {
            const station = metroStationById.get(stationId);

            return station ? <span key={stationId}>{station.name}</span> : null;
          })}
        </div>
      ) : null}
      <select
        multiple
        className="quick-edit-select quick-edit-select--multiple"
        value={draftIds}
        onChange={(event) =>
          setDraftIds(Array.from(event.currentTarget.selectedOptions, (option) => option.value))
        }
        onKeyDown={handleEditorKeyDown}
      >
        {filteredStations.map((station) => (
          <option key={station.id} value={station.id}>
            {station.lineName ? `${station.name}, ${station.lineName}` : station.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function SortButton({
  active,
  children,
  direction,
  onClick,
}: {
  active: boolean;
  children: string;
  direction: SortDirection;
  onClick: () => void;
}) {
  return (
    <AdminButton
      className={active ? 'table-sort-button table-sort-button--active' : 'table-sort-button'}
      fit={false}
      tone="text"
      type="button"
      onClick={onClick}
    >
      <span className="table-sort-label">{children}</span>
      {active ? (
        direction === 'asc' ? (
          <ArrowUpIcon data-icon="inline-end" />
        ) : (
          <ArrowDownIcon data-icon="inline-end" />
        )
      ) : (
        <ArrowUpDownIcon data-icon="inline-end" />
      )}
    </AdminButton>
  );
}

function getSortAria(activeSortBy: SortField, direction: SortDirection, sortField: SortField) {
  if (activeSortBy !== sortField) {
    return undefined;
  }

  return direction === 'asc' ? 'ascending' : 'descending';
}

function getTextCellCommitValue(columnKey: ObjectQuickEditColumnKey, value: string): ObjectQuickEditCellValue {
  if (columnKey === 'completion') {
    return parseQuickEditCompletion(value);
  }

  if (columnKey === 'apartmentAreaRange') {
    return normalizeApartmentAreaRange(value);
  }

  return value;
}

function getCellDisplayValue(object: RealEstateObjectSummary, columnKey: ObjectQuickEditColumnKey) {
  switch (columnKey) {
    case 'priceFrom':
      return formatPrice(object.priceFrom);
    case 'pricePerMeterFrom':
      return formatPrice(object.pricePerMeterFrom);
    case 'developer':
      return object.developer?.name ?? null;
    case 'krtName':
      return object.krtName;
    case 'completion':
      return formatCompletion(object.completionYear, object.completionQuarter);
    case 'metro':
      return getObjectMetroSummary(object);
    case 'propertyClass':
      return object.propertyClass;
    case 'apartmentsCountText':
      return object.apartmentsCountText;
    case 'apartmentAreaRange':
      return object.apartmentAreaRange;
    case 'ceilingHeight':
      return object.ceilingHeight;
    case 'floorRange':
      return object.floorRange;
    case 'coordinates':
      return formatCoordinatePair(object.latitude, object.longitude);
    case 'status':
      return objectStatusLabels[object.status];
    case 'title':
      return object.title;
    default:
      return null;
  }
}

function getCellDraftValue(object: RealEstateObjectSummary, columnKey: ObjectQuickEditColumnKey): string {
  switch (columnKey) {
    case 'title':
      return object.title;
    case 'priceFrom':
      return object.priceFrom ?? '';
    case 'pricePerMeterFrom':
      return object.pricePerMeterFrom ?? '';
    case 'krtName':
      return object.krtName ?? '';
    case 'completion':
      return object.completionYear ? formatCompletion(object.completionYear, object.completionQuarter) ?? '' : '';
    case 'apartmentsCountText':
      return object.apartmentsCountText ?? '';
    case 'apartmentAreaRange':
      return object.apartmentAreaRange ?? '';
    case 'ceilingHeight':
      return object.ceilingHeight ?? '';
    case 'floorRange':
      return object.floorRange ?? '';
    case 'coordinates':
      return formatCoordinatePair(object.latitude, object.longitude) ?? '';
    default:
      return '';
  }
}

function getObjectMetroSummary(object: ObjectWithMetroStations) {
  if (object.metroStations.length === 0) {
    return null;
  }

  const stationNames = object.metroStations.map((station) =>
    station.lineName ? `${station.name}, ${station.lineName}` : station.name,
  );

  if (stationNames.length <= 2) {
    return stationNames.join(', ');
  }

  return `${stationNames.slice(0, 2).join(', ')} и еще ${stationNames.length - 2}`;
}

function formatPrice(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return value;
  }

  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 0,
    style: 'currency',
    currency: 'RUB',
  }).format(parsed);
}

function formatCompletion(year: number | string | null, quarter: number | string | null) {
  if (!year) {
    return null;
  }

  return quarter ? `${quarter} кв. ${year}` : String(year);
}

function formatCoordinatePair(latitude: number | null, longitude: number | null) {
  if (latitude !== null && longitude !== null) {
    return `${latitude}, ${longitude}`;
  }

  if (latitude !== null) {
    return String(latitude);
  }

  if (longitude !== null) {
    return String(longitude);
  }

  return null;
}
