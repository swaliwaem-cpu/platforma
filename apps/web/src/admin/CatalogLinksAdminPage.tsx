import { FocusEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftIcon, ChevronDownIcon, PlusIcon, SaveIcon, Trash2Icon, XIcon } from 'lucide-react';
import type {
  AdminCatalogLinksResponse,
  AdminCatalogQuickLink,
  AdminCatalogQuickLinkObject,
  CatalogQuickLinkType,
  DevelopersResponse,
  ObjectDeveloper,
  ObjectsResponse,
  RealEstateObjectSummary,
  UpdateCatalogLinksRequest,
  UpdateCatalogQuickLinkInput,
} from '@platforma/shared';

import { Input } from '@/components/ui/input';

import { useAuth } from '../auth/AuthProvider';
import { AdminAlert, AdminButton, AdminEmptyState, AdminPanel, AdminStatusBadge } from './AdminUi';
import { apiRequest } from './api';
import { matchesQuickEditSearch } from './objectQuickEditTransforms';
import './admin-route-pages.css';

type CatalogLinkDraft = UpdateCatalogQuickLinkInput & {
  clientId: string;
  developer: ObjectDeveloper | null;
  object: AdminCatalogQuickLinkObject | null;
};

type CatalogLinkColumnConfig = {
  type: CatalogQuickLinkType;
  title: string;
  description: string;
  targetLabel: string;
  addLabel: string;
};

type CatalogTargetObject = Pick<RealEstateObjectSummary, 'id' | 'title' | 'slug' | 'status' | 'krtName'>;

type CatalogKrtOption = {
  id: string;
  name: string;
};

const catalogLinkObjectPageSize = 100;
const catalogLinkSearchResultLimit = 24;

const catalogLinkColumns = [
  {
    type: 'DEVELOPER',
    title: 'Крупные застройщики',
    description: 'Переход в выдачу по выбранному застройщику.',
    targetLabel: 'Застройщик',
    addLabel: 'Добавить застройщика',
  },
  {
    type: 'KRT',
    title: 'Основные локации КРТ',
    description: 'Переход в выдачу по точному названию КРТ.',
    targetLabel: 'КРТ',
    addLabel: 'Добавить КРТ',
  },
  {
    type: 'SALES_START',
    title: 'Старты продаж',
    description: 'Переход на карточку опубликованного объекта.',
    targetLabel: 'Объект',
    addLabel: 'Добавить объект',
  },
] as const satisfies readonly CatalogLinkColumnConfig[];

let newLinkCounter = 0;

async function loadPublishedCatalogObjects(accessToken: string) {
  const createParams = (page: number) =>
    new URLSearchParams({
      page: String(page),
      limit: String(catalogLinkObjectPageSize),
      status: 'PUBLISHED',
      sortBy: 'title',
      sortDirection: 'asc',
    });

  const firstPage = await apiRequest<ObjectsResponse>(`/objects?${createParams(1).toString()}`, accessToken);
  const remainingPageRequests: Array<Promise<ObjectsResponse>> = [];

  for (let page = 2; page <= firstPage.totalPages; page += 1) {
    remainingPageRequests.push(apiRequest<ObjectsResponse>(`/objects?${createParams(page).toString()}`, accessToken));
  }

  const remainingPages = await Promise.all(remainingPageRequests);

  return [firstPage, ...remainingPages]
    .flatMap((page) => page.items)
    .filter((object) => object.status === 'PUBLISHED')
    .map((object) => ({
      id: object.id,
      title: object.title,
      slug: object.slug,
      status: object.status,
      krtName: object.krtName,
    }));
}

export function CatalogLinksAdminPage({ onBack }: { onBack: () => void }) {
  const { accessToken } = useAuth();
  const [links, setLinks] = useState<CatalogLinkDraft[]>([]);
  const [developers, setDevelopers] = useState<ObjectDeveloper[]>([]);
  const [publishedObjects, setPublishedObjects] = useState<CatalogTargetObject[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const developerOptions = useMemo(() => mergeDevelopers(developers, links), [developers, links]);
  const publishedObjectOptions = useMemo(
    () => mergePublishedObjects(publishedObjects, links),
    [links, publishedObjects],
  );
  const krtOptions = useMemo(() => mergeKrtOptions(publishedObjects, links), [links, publishedObjects]);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    void loadCatalogLinks();
  }, [accessToken]);

  async function loadCatalogLinks() {
    if (!accessToken) {
      return;
    }

    setIsLoading(true);
    setError(null);
    setNotice(null);

    try {
      const [linksData, developersData, objectsData] = await Promise.all([
        apiRequest<AdminCatalogLinksResponse>('/catalog-links/admin', accessToken),
        apiRequest<DevelopersResponse>('/developers?limit=500', accessToken),
        loadPublishedCatalogObjects(accessToken),
      ]);

      setLinks(linksData.items.map(createCatalogLinkDraft));
      setDevelopers(developersData.items);
      setPublishedObjects(objectsData);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось загрузить ссылки каталога');
    } finally {
      setIsLoading(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!accessToken) {
      return;
    }

    const validationError = validateCatalogLinks(links);

    if (validationError) {
      setError(validationError);
      setNotice(null);
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setNotice(null);

    try {
      const payload: UpdateCatalogLinksRequest = {
        items: links.map(toCatalogLinkInput),
      };
      const data = await apiRequest<AdminCatalogLinksResponse>('/catalog-links/admin', accessToken, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });

      setLinks(data.items.map(createCatalogLinkDraft));
      setNotice('Ссылки каталога сохранены');
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : 'Не удалось сохранить ссылки каталога');
    } finally {
      setIsSubmitting(false);
    }
  }

  function updateLink(clientId: string, updater: (link: CatalogLinkDraft) => CatalogLinkDraft) {
    setLinks((currentLinks) => currentLinks.map((link) => (link.clientId === clientId ? updater(link) : link)));
  }

  function addLink(type: CatalogQuickLinkType) {
    setLinks((currentLinks) => [
      ...currentLinks,
      createEmptyCatalogLinkDraft(type, getNextSortOrder(currentLinks, type)),
    ]);
  }

  function deleteLink(clientId: string) {
    setLinks((currentLinks) => currentLinks.filter((link) => link.clientId !== clientId));
  }

  return (
    <div className="admin-catalog-links">
      <header className="page-header">
        <div>
          <p className="eyebrow">Админка</p>
          <h2>Ссылки каталога</h2>
        </div>
        <div className="header-actions">
          <AdminButton tone="secondary" type="button" onClick={onBack}>
            <ArrowLeftIcon data-icon="inline-start" />
            Назад
          </AdminButton>
          <AdminButton disabled={isLoading || isSubmitting} form="catalog-links-form" tone="primary" type="submit">
            <SaveIcon data-icon="inline-start" />
            {isSubmitting ? 'Сохранение' : 'Сохранить'}
          </AdminButton>
        </div>
      </header>

      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}

      <form id="catalog-links-form" className="catalog-links-form" onSubmit={handleSubmit}>
        <fieldset disabled={isLoading || isSubmitting}>
          <AdminPanel className="catalog-links-panel">
            <div className="table-meta catalog-links-meta">
              <span>{isLoading ? 'Загрузка ссылок' : `Строк: ${links.length}`}</span>
              <AdminStatusBadge className="status-pill--active">Каталог</AdminStatusBadge>
            </div>

            {isLoading ? (
              <AdminEmptyState title="Загрузка ссылок каталога" />
            ) : (
              <div className="catalog-links-columns">
                {catalogLinkColumns.map((column) => (
                  <CatalogLinkColumnEditor
                    key={column.type}
                    column={column}
                    developers={developerOptions}
                    krtOptions={krtOptions}
                    links={getLinksByType(links, column.type)}
                    publishedObjects={publishedObjectOptions}
                    onAddLink={addLink}
                    onDeleteLink={deleteLink}
                    onUpdateLink={updateLink}
                  />
                ))}
              </div>
            )}
          </AdminPanel>
        </fieldset>
      </form>
    </div>
  );
}

function CatalogLinkColumnEditor({
  column,
  developers,
  krtOptions,
  links,
  publishedObjects,
  onAddLink,
  onDeleteLink,
  onUpdateLink,
}: {
  column: CatalogLinkColumnConfig;
  developers: ObjectDeveloper[];
  krtOptions: CatalogKrtOption[];
  links: CatalogLinkDraft[];
  publishedObjects: CatalogTargetObject[];
  onAddLink: (type: CatalogQuickLinkType) => void;
  onDeleteLink: (clientId: string) => void;
  onUpdateLink: (clientId: string, updater: (link: CatalogLinkDraft) => CatalogLinkDraft) => void;
}) {
  return (
    <section className="catalog-link-column" aria-label={column.title}>
      <div className="catalog-link-column-header">
        <div>
          <h3>{column.title}</h3>
          <p>{column.description}</p>
        </div>
        <AdminStatusBadge>{links.length}</AdminStatusBadge>
      </div>

      <div className="catalog-link-column-body">
        {links.length ? (
          links.map((row) => (
            <CatalogLinkRowEditor
              key={row.clientId}
              column={column}
              developers={developers}
              krtOptions={krtOptions}
              publishedObjects={publishedObjects}
              row={row}
              onDeleteLink={onDeleteLink}
              onUpdateLink={onUpdateLink}
            />
          ))
        ) : (
          <p className="catalog-link-empty">Строк пока нет.</p>
        )}
      </div>

      <AdminButton tone="secondary" type="button" onClick={() => onAddLink(column.type)}>
        <PlusIcon data-icon="inline-start" />
        {column.addLabel}
      </AdminButton>
    </section>
  );
}

function CatalogLinkRowEditor({
  column,
  developers,
  krtOptions,
  publishedObjects,
  row,
  onDeleteLink,
  onUpdateLink,
}: {
  column: CatalogLinkColumnConfig;
  developers: ObjectDeveloper[];
  krtOptions: CatalogKrtOption[];
  publishedObjects: CatalogTargetObject[];
  row: CatalogLinkDraft;
  onDeleteLink: (clientId: string) => void;
  onUpdateLink: (clientId: string, updater: (link: CatalogLinkDraft) => CatalogLinkDraft) => void;
}) {
  const rowLabel = row.label.trim() || column.title;

  return (
    <article className="catalog-link-row">
      <label className="catalog-link-field">
        <span>Название</span>
        <Input
          aria-label={`Название ссылки ${rowLabel}`}
          maxLength={160}
          type="text"
          value={row.label}
          onChange={(event) =>
            onUpdateLink(row.clientId, (currentLink) => ({
              ...currentLink,
              label: event.target.value,
            }))
          }
        />
      </label>

      <CatalogLinkTargetField
        column={column}
        developers={developers}
        krtOptions={krtOptions}
        publishedObjects={publishedObjects}
        row={row}
        onUpdateLink={onUpdateLink}
      />

      <div className="catalog-link-row-settings">
        <label className="catalog-link-enabled">
          <input
            aria-label={`Включить ссылку ${rowLabel}`}
            checked={row.isEnabled}
            type="checkbox"
            onChange={(event) =>
              onUpdateLink(row.clientId, (currentLink) => ({
                ...currentLink,
                isEnabled: event.target.checked,
              }))
            }
          />
          <span>Включено</span>
        </label>

        <label className="catalog-link-field catalog-link-sort-field">
          <span>Порядок</span>
          <Input
            aria-label={`Порядок ссылки ${rowLabel}`}
            inputMode="numeric"
            max={1000}
            min={0}
            type="number"
            value={row.sortOrder}
            onChange={(event) =>
              onUpdateLink(row.clientId, (currentLink) => ({
                ...currentLink,
                sortOrder: parseSortOrderInput(event.target.value),
              }))
            }
          />
        </label>

        <AdminButton
          aria-label={`Удалить ссылку ${rowLabel}`}
          className="catalog-link-delete-button"
          tone="danger"
          type="button"
          onClick={() => onDeleteLink(row.clientId)}
        >
          <Trash2Icon aria-hidden="true" />
        </AdminButton>
      </div>
    </article>
  );
}

function CatalogLinkTargetField({
  column,
  developers,
  krtOptions,
  publishedObjects,
  row,
  onUpdateLink,
}: {
  column: CatalogLinkColumnConfig;
  developers: ObjectDeveloper[];
  krtOptions: CatalogKrtOption[];
  publishedObjects: CatalogTargetObject[];
  row: CatalogLinkDraft;
  onUpdateLink: (clientId: string, updater: (link: CatalogLinkDraft) => CatalogLinkDraft) => void;
}) {
  const rowLabel = row.label.trim() || column.title;

  if (row.type === 'DEVELOPER') {
    return (
      <div className="catalog-link-field">
        <span>{column.targetLabel}</span>
        <CatalogLinkSearchSelect
          ariaLabel={`Целевой застройщик ${rowLabel}`}
          emptyLabel="Застройщики не найдены"
          getOptionLabel={(developer) => developer.name}
          getSearchValues={(developer) => [developer.name, developer.slug]}
          options={developers}
          placeholder="Найти застройщика"
          selectedId={row.developerId ?? ''}
          onSelectedIdChange={(developerId) => {
            const selectedDeveloper = developers.find((developer) => developer.id === developerId) ?? null;

            onUpdateLink(row.clientId, (currentLink) => ({
              ...currentLink,
              developerId: developerId || null,
              developer: selectedDeveloper,
              label: currentLink.label.trim() ? currentLink.label : (selectedDeveloper?.name ?? currentLink.label),
            }));
          }}
        />
      </div>
    );
  }

  if (row.type === 'KRT') {
    return (
      <div className="catalog-link-field">
        <span>{column.targetLabel}</span>
        <CatalogLinkSearchSelect
          ariaLabel={`Целевая КРТ ${rowLabel}`}
          emptyLabel="КРТ не найдены"
          getOptionLabel={(krt) => krt.name}
          getSearchValues={(krt) => [krt.name]}
          options={krtOptions}
          placeholder="Найти КРТ"
          selectedId={row.krtName?.trim() ?? ''}
          onSelectedIdChange={(krtName) => {
            const selectedKrt = krtOptions.find((krt) => krt.id === krtName) ?? null;

            onUpdateLink(row.clientId, (currentLink) => ({
              ...currentLink,
              krtName: krtName || null,
              label: currentLink.label.trim() ? currentLink.label : (selectedKrt?.name ?? currentLink.label),
            }));
          }}
        />
      </div>
    );
  }

  if (row.type === 'SALES_START') {
    const selectedObject = publishedObjects.find((object) => object.id === row.objectId) ?? null;

    return (
      <div className="catalog-link-field">
        <span>{column.targetLabel}</span>
        <CatalogLinkSearchSelect
          ariaLabel={`Целевой объект ${rowLabel}`}
          emptyLabel="Объекты не найдены"
          getOptionLabel={(object) => `${object.title} / ${object.slug}`}
          getSearchValues={(object) => [object.title, object.slug]}
          options={publishedObjects}
          placeholder="Найти объект"
          selectedId={row.objectId ?? ''}
          onSelectedIdChange={(objectId) => {
            const nextObject = publishedObjects.find((object) => object.id === objectId) ?? null;

            onUpdateLink(row.clientId, (currentLink) => ({
              ...currentLink,
              objectId: objectId || null,
              object: nextObject,
              label: currentLink.label.trim() ? currentLink.label : (nextObject?.title ?? currentLink.label),
            }));
          }}
        />
        {selectedObject ? (
          <a className="catalog-link-public-url" href={`/objects/${encodeURIComponent(selectedObject.slug)}`}>
            /objects/{selectedObject.slug}
          </a>
        ) : null}
      </div>
    );
  }

  return null;
}

type CatalogLinkSearchSelectOption = {
  id: string;
};

function CatalogLinkSearchSelect<T extends CatalogLinkSearchSelectOption>({
  ariaLabel,
  emptyLabel,
  getOptionLabel,
  getSearchValues,
  options,
  placeholder,
  selectedId,
  onSelectedIdChange,
}: {
  ariaLabel: string;
  emptyLabel: string;
  getOptionLabel: (option: T) => string;
  getSearchValues: (option: T) => Array<string | null | undefined>;
  options: T[];
  placeholder: string;
  selectedId: string;
  onSelectedIdChange: (id: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectedOption = useMemo(
    () => options.find((option) => option.id === selectedId) ?? null,
    [options, selectedId],
  );
  const filteredOptions = useMemo(() => {
    const matchedOptions = options.filter((option) => matchesQuickEditSearch(query, getSearchValues(option)));

    return matchedOptions.slice(0, catalogLinkSearchResultLimit);
  }, [getSearchValues, options, query]);

  function selectOption(optionId: string) {
    onSelectedIdChange(optionId);
    setQuery('');
    setIsOpen(false);
  }

  function clearSelection() {
    onSelectedIdChange('');
    setQuery('');
    inputRef.current?.focus();
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setIsOpen(false);
    setQuery('');
  }

  function handleInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setIsOpen(false);
      setQuery('');
      return;
    }

    if (event.key === 'Enter' && isOpen && filteredOptions[0]) {
      event.preventDefault();
      selectOption(filteredOptions[0].id);
      return;
    }

    if (event.key === 'Backspace' && !query && selectedId) {
      clearSelection();
    }
  }

  return (
    <div className="searchable-multi-select" onBlur={handleBlur}>
      <div
        className={isOpen ? 'searchable-multi-select-control is-open' : 'searchable-multi-select-control'}
        onClick={() => {
          setIsOpen(true);
          inputRef.current?.focus();
        }}
      >
        <div className="searchable-multi-select-value">
          {selectedOption ? (
            <button
              className="searchable-multi-select-chip"
              type="button"
              aria-label={`Убрать ${getOptionLabel(selectedOption)}`}
              onClick={(event) => {
                event.stopPropagation();
                clearSelection();
              }}
            >
              <span>{getOptionLabel(selectedOption)}</span>
              <XIcon aria-hidden="true" />
            </button>
          ) : null}
          <input
            ref={inputRef}
            aria-expanded={isOpen}
            aria-label={ariaLabel}
            role="combobox"
            type="search"
            value={query}
            placeholder={selectedOption ? '' : placeholder}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setIsOpen(true);
            }}
            onFocus={() => setIsOpen(true)}
            onKeyDown={handleInputKeyDown}
          />
        </div>
        {selectedOption ? (
          <button
            className="searchable-multi-select-clear"
            type="button"
            aria-label={`Очистить ${ariaLabel}`}
            onClick={(event) => {
              event.stopPropagation();
              clearSelection();
            }}
          >
            <XIcon aria-hidden="true" />
          </button>
        ) : null}
        <ChevronDownIcon className="searchable-multi-select-chevron" aria-hidden="true" />
      </div>
      {isOpen ? (
        <div className="searchable-multi-select-menu" role="listbox">
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option) => {
              const isSelected = option.id === selectedId;

              return (
                <button
                  key={option.id}
                  className={
                    isSelected
                      ? 'searchable-multi-select-option searchable-multi-select-option--selected'
                      : 'searchable-multi-select-option'
                  }
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onClick={() => selectOption(option.id)}
                >
                  <span>{getOptionLabel(option)}</span>
                  {isSelected ? <span className="searchable-multi-select-check">Выбрано</span> : null}
                </button>
              );
            })
          ) : (
            <p className="searchable-multi-select-empty">{emptyLabel}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function createCatalogLinkDraft(link: AdminCatalogQuickLink): CatalogLinkDraft {
  return {
    clientId: link.id,
    id: link.id,
    type: link.type,
    label: link.label,
    sortOrder: link.sortOrder,
    isEnabled: link.isEnabled,
    developerId: link.developerId,
    objectId: link.objectId,
    krtName: link.krtName,
    developer: link.developer,
    object: link.object,
  };
}

function createEmptyCatalogLinkDraft(type: CatalogQuickLinkType, sortOrder: number): CatalogLinkDraft {
  newLinkCounter += 1;

  return {
    clientId: `new-catalog-link-${newLinkCounter}`,
    type,
    label: '',
    sortOrder,
    isEnabled: true,
    developerId: null,
    objectId: null,
    krtName: null,
    developer: null,
    object: null,
  };
}

function getLinksByType(links: CatalogLinkDraft[], type: CatalogQuickLinkType) {
  return links
    .filter((link) => link.type === type)
    .sort(
      (firstLink, secondLink) =>
        firstLink.sortOrder - secondLink.sortOrder || firstLink.label.localeCompare(secondLink.label),
    );
}

function getNextSortOrder(links: CatalogLinkDraft[], type: CatalogQuickLinkType) {
  const sameTypeLinks = links.filter((link) => link.type === type);

  if (sameTypeLinks.length === 0) {
    return 0;
  }

  return Math.min(1000, Math.max(...sameTypeLinks.map((link) => link.sortOrder)) + 1);
}

function parseSortOrderInput(value: string) {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }

  return Math.min(parsed, 1000);
}

function toCatalogLinkInput(link: CatalogLinkDraft): UpdateCatalogQuickLinkInput {
  return {
    ...(link.id ? { id: link.id } : {}),
    type: link.type,
    label: link.label.trim(),
    sortOrder: link.sortOrder,
    isEnabled: link.isEnabled,
    developerId: link.type === 'DEVELOPER' ? (link.developerId ?? null) : null,
    objectId: link.type === 'SALES_START' ? (link.objectId ?? null) : null,
    krtName: link.type === 'KRT' ? (link.krtName?.trim() || null) : null,
  };
}

function validateCatalogLinks(links: CatalogLinkDraft[]) {
  for (const link of links) {
    if (!link.label.trim()) {
      return 'Заполните название каждой ссылки каталога';
    }

    if (!link.isEnabled) {
      continue;
    }

    if (link.type === 'DEVELOPER' && !link.developerId) {
      return 'Для включенного застройщика выберите цель';
    }

    if (link.type === 'KRT' && !link.krtName?.trim()) {
      return 'Для включенной КРТ-ссылки заполните название КРТ';
    }

    if (link.type === 'SALES_START' && !link.objectId) {
      return 'Для включенного старта продаж выберите опубликованный объект';
    }
  }

  return null;
}

function mergeDevelopers(developers: ObjectDeveloper[], links: CatalogLinkDraft[]) {
  const byId = new Map(developers.map((developer) => [developer.id, developer]));

  for (const link of links) {
    if (link.developer && !byId.has(link.developer.id)) {
      byId.set(link.developer.id, link.developer);
    }
  }

  return Array.from(byId.values()).sort((firstDeveloper, secondDeveloper) =>
    firstDeveloper.name.localeCompare(secondDeveloper.name, 'ru'),
  );
}

function mergePublishedObjects(publishedObjects: CatalogTargetObject[], links: CatalogLinkDraft[]) {
  const byId = new Map(publishedObjects.map((object) => [object.id, object]));

  for (const link of links) {
    if (link.object && link.object.status === 'PUBLISHED' && !byId.has(link.object.id)) {
      byId.set(link.object.id, {
        ...link.object,
        krtName: null,
      });
    }
  }

  return Array.from(byId.values()).sort((firstObject, secondObject) =>
    firstObject.title.localeCompare(secondObject.title, 'ru'),
  );
}

function mergeKrtOptions(publishedObjects: CatalogTargetObject[], links: CatalogLinkDraft[]) {
  const byName = new Map<string, CatalogKrtOption>();

  for (const object of publishedObjects) {
    const krtName = object.krtName?.trim();

    if (krtName) {
      byName.set(krtName.toLocaleLowerCase('ru'), {
        id: krtName,
        name: krtName,
      });
    }
  }

  for (const link of links) {
    const krtName = link.type === 'KRT' ? link.krtName?.trim() : '';

    if (krtName) {
      byName.set(krtName.toLocaleLowerCase('ru'), {
        id: krtName,
        name: krtName,
      });
    }
  }

  return Array.from(byName.values()).sort((firstKrt, secondKrt) => firstKrt.name.localeCompare(secondKrt.name, 'ru'));
}
