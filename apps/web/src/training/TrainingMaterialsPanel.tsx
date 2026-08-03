import { FocusEvent, FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import type {
  TrainingMaterial,
  TrainingMaterialDetail,
  TrainingMaterialRevisionStatus,
  TrainingMaterialStatus,
  TrainingMaterialSuggestion,
  TrainingMaterialType,
  TrainingObjectOption,
} from '@platforma/shared';
import {
  ArchiveIcon,
  Building2Icon,
  DownloadIcon,
  FileTextIcon,
  Globe2Icon,
  KeyboardIcon,
  RefreshCwIcon,
  SearchIcon,
  PlusIcon,
  SparklesIcon,
  XIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from 'lucide-react';

import { AdminAlert, AdminButton } from '../admin/AdminUi';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  applyTrainingMaterialSuggestions,
  archiveTrainingMaterial,
  createTrainingManualMaterial,
  createTrainingPdfMaterial,
  createTrainingUrlMaterial,
  downloadTrainingMaterialPdf,
  generateTrainingMaterialSuggestions,
  getTrainingMaterial,
  getTrainingMaterials,
  getTrainingObjectOptions,
  importTrainingObjectContent,
  refreshTrainingMaterial,
  refreshTrainingPdfMaterial,
} from './trainingApi';

type TrainingMaterialsPanelProps = {
  accessToken: string;
  disabled: boolean;
  hasQuestions: boolean;
  projectId: string;
  linkedObjectId: string | null;
  onMaterialsCountChange: (count: number) => void;
  onProjectContentChanged: () => void | Promise<void>;
};

type CreatableTrainingMaterialType = Exclude<TrainingMaterialType, 'OBJECT_SNAPSHOT'>;
type MaterialCreateError = {
  field: 'title' | 'file' | 'url' | 'form';
  message: string;
};

const typeLabels: Record<TrainingMaterialType, string> = {
  PDF: 'Документ PDF',
  OFFICIAL_URL: 'Официальная ссылка',
  MANUAL_TEXT: 'Ручной текст',
  OBJECT_SNAPSHOT: 'Карточка Platforma',
};

const materialStatusLabels: Record<TrainingMaterialStatus, string> = {
  ACTIVE: 'Активен',
  ARCHIVED: 'В архиве',
};

const revisionStatusLabels: Record<TrainingMaterialRevisionStatus, string> = {
  READY: 'Готово',
  FAILED: 'Ошибка',
};

const objectStatusLabels: Record<TrainingObjectOption['status'], string> = {
  DRAFT: 'Черновик',
  PUBLISHED: 'Опубликован',
  ARCHIVED: 'В архиве',
};

const creatableMaterialTypes: readonly CreatableTrainingMaterialType[] = [
  'PDF',
  'OFFICIAL_URL',
  'MANUAL_TEXT',
];

const typeIcons = {
  PDF: FileTextIcon,
  OFFICIAL_URL: Globe2Icon,
  MANUAL_TEXT: KeyboardIcon,
  OBJECT_SNAPSHOT: Building2Icon,
} as const;

const objectFields = [
  ['title', 'Название'],
  ['type', 'Тип объекта'],
  ['architectureDescription', 'Архитектура'],
  ['infrastructureDescription', 'Инфраструктура'],
  ['fillingDescription', 'Отделка и наполнение'],
  ['krtName', 'КРТ'],
  ['apartmentAreaRange', 'Площади'],
  ['ceilingHeight', 'Высота потолков'],
  ['propertyClass', 'Класс'],
  ['floorRange', 'Этажность'],
  ['completion', 'Срок сдачи'],
  ['address', 'Адрес'],
  ['developer', 'Девелопер'],
  ['locations', 'Районы'],
  ['metroStations', 'Метро'],
] as const;

export function TrainingMaterialsPanel({
  accessToken,
  disabled,
  hasQuestions,
  projectId,
  linkedObjectId,
  onMaterialsCountChange,
  onProjectContentChanged,
}: TrainingMaterialsPanelProps) {
  const [materials, setMaterials] = useState<TrainingMaterial[]>([]);
  const [selected, setSelected] = useState<TrainingMaterialDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<MaterialCreateError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [materialSearch, setMaterialSearch] = useState('');
  const [materialTypeFilter, setMaterialTypeFilter] = useState<'ALL' | TrainingMaterialType>('ALL');
  const [createType, setCreateType] = useState<CreatableTrainingMaterialType>('MANUAL_TEXT');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [officialConfirmed, setOfficialConfirmed] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fieldCodes, setFieldCodes] = useState<string[]>(['title']);
  const [selectedSuggestionIds, setSelectedSuggestionIds] = useState<string[]>([]);
  const [suggestionDrafts, setSuggestionDrafts] = useState<TrainingMaterialSuggestion[]>([]);
  const [refreshText, setRefreshText] = useState('');
  const [refreshFile, setRefreshFile] = useState<File | null>(null);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [objectOptions, setObjectOptions] = useState<TrainingObjectOption[]>([]);
  const [selectedObjectId, setSelectedObjectId] = useState(linkedObjectId ?? '');
  const [objectSearch, setObjectSearch] = useState('');
  const [isObjectOptionsLoading, setIsObjectOptionsLoading] = useState(false);
  const [objectOptionsError, setObjectOptionsError] = useState<string | null>(null);
  const selectedRevision = selected?.revisions.find((revision) => revision.id === selectedRevisionId)
    ?? selected?.revisions[0]
    ?? null;

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    void getTrainingMaterials(accessToken, projectId, controller.signal)
      .then(async (response) => {
        if (controller.signal.aborted) return;
        setMaterials(response.items);
        onMaterialsCountChange(response.items.length);
        const nextId = selected?.id && response.items.some((item) => item.id === selected.id)
          ? selected.id
          : response.items[0]?.id;
        if (nextId) {
          const detail = await getTrainingMaterial(accessToken, nextId, controller.signal);
          if (!controller.signal.aborted) setSelected(detail);
        } else {
          setSelected(null);
        }
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить материалы');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
  }, [accessToken, onMaterialsCountChange, projectId, reloadKey]);

  useEffect(() => {
    setSelectedRevisionId(selected?.revisions[0]?.id ?? null);
  }, [selected?.id, selected?.revisions[0]?.id]);

  useEffect(() => {
    const suggestions = selectedRevision?.suggestions ?? [];
    setSuggestionDrafts(suggestions.map((suggestion) => ({
      ...suggestion,
      aliases: [...suggestion.aliases],
    })));
    setSelectedSuggestionIds([]);
    setRefreshText(selectedRevision?.extractedText ?? '');
    const selectedFieldCodes = selectedRevision?.extractionMetadata.fieldCodes;
    if (Array.isArray(selectedFieldCodes) && selectedFieldCodes.every((code) => typeof code === 'string')) {
      setFieldCodes(selectedFieldCodes);
    }
  }, [selectedRevision?.id, selectedRevision?.suggestionStatus]);

  useEffect(() => {
    setSelectedObjectId(linkedObjectId ?? '');
  }, [linkedObjectId]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setIsObjectOptionsLoading(true);
      setObjectOptionsError(null);
      void getTrainingObjectOptions(accessToken, projectId, objectSearch, controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return;
          setObjectOptions((current) => mergeObjectOptions(
            response.items,
            response.selected,
            current.find((option) => option.id === selectedObjectId) ?? null,
          ));
        })
        .catch((loadError: unknown) => {
          if (!controller.signal.aborted) {
            setObjectOptionsError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить список ЖК');
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsObjectOptionsLoading(false);
        });
    }, objectSearch ? 250 : 0);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [accessToken, objectSearch, projectId, selectedObjectId]);

  const selectedSuggestions = useMemo(
    () => suggestionDrafts.filter((suggestion) => selectedSuggestionIds.includes(suggestion.id)),
    [selectedSuggestionIds, suggestionDrafts],
  );
  const visibleMaterials = useMemo(() => {
    const normalizedSearch = materialSearch.trim().toLocaleLowerCase('ru-RU');
    return materials.filter((material) => {
      const matchesType = materialTypeFilter === 'ALL' || material.type === materialTypeFilter;
      const matchesSearch = !normalizedSearch || material.title.toLocaleLowerCase('ru-RU').includes(normalizedSearch);
      return matchesType && matchesSearch;
    });
  }, [materialSearch, materialTypeFilter, materials]);

  const runAction = async (
    action: string,
    operation: () => Promise<TrainingMaterialDetail>,
    success: string,
  ) => {
    if (pendingAction) return;
    setPendingAction(action);
    setError(null);
    setNotice(null);
    try {
      const detail = await operation();
      setSelected(detail);
      setNotice(success);
      setReloadKey((value) => value + 1);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Действие не выполнено');
    } finally {
      setPendingAction(null);
    }
  };

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (pendingAction) return;
    if (!title.trim()) {
      setCreateError({ field: 'title', message: 'Укажите название материала.' });
      return;
    }
    if (createType === 'PDF' && !file) {
      setCreateError({ field: 'file', message: 'Выберите PDF-файл.' });
      return;
    }

    const submittedType = createType;
    const createMaterial = (replaceExistingQuestions: boolean) => {
      if (submittedType === 'PDF') {
        return createTrainingPdfMaterial(
          accessToken,
          projectId,
          title.trim(),
          file as File,
          replaceExistingQuestions,
        );
      }
      if (submittedType === 'OFFICIAL_URL') {
        return createTrainingUrlMaterial(accessToken, projectId, {
          title: title.trim(),
          url: url.trim(),
          officialConfirmed: officialConfirmed as true,
          replaceExistingQuestions,
        });
      }
      return createTrainingManualMaterial(accessToken, projectId, {
        title: title.trim(), text,
      });
    };

    setPendingAction('create');
    setError(null);
    setCreateError(null);
    setNotice(null);
    try {
      let detail: TrainingMaterialDetail;
      try {
        detail = await createMaterial(false);
      } catch (createError) {
        const message = createError instanceof Error ? createError.message : 'Не удалось создать материал';
        const createsQuestions = submittedType === 'PDF' || submittedType === 'OFFICIAL_URL';
        if (!createsQuestions || message !== 'PROJECT_QUESTIONS_REPLACE_CONFIRMATION_REQUIRED') {
          throw createError;
        }
        const confirmed = window.confirm(
          'В проекте уже есть вопросы и эталонные ответы. Заменить их новыми автоматически созданными черновиками на основе этого источника?',
        );
        if (!confirmed) return;
        detail = await createMaterial(true);
      }

      setSelected(detail);
      setIsCreateOpen(false);
      setReloadKey((value) => value + 1);
      const questionsGenerated = (submittedType === 'PDF' || submittedType === 'OFFICIAL_URL') &&
        detail.latestRevision?.status === 'READY';
      setNotice(questionsGenerated
        ? 'Материал создан. Сформированы 1 главный и 10 дополнительных вопросов с активными эталонными ответами.'
        : detail.latestRevision?.status === 'FAILED'
          ? 'Материал сохранён, но текст не извлечён, поэтому вопросы и ответы не созданы.'
          : 'Материал создан. Извлечённый текст остаётся административным черновиком.');
      if (questionsGenerated) await onProjectContentChanged();
    } catch (createError) {
      setCreateError({
        field: submittedType === 'OFFICIAL_URL'
          ? 'url'
          : submittedType === 'PDF'
            ? 'file'
            : 'form',
        message: formatMaterialCreateError(createError),
      });
    } finally {
      setPendingAction(null);
    }
  };

  const openMaterial = async (materialId: string) => {
    if (pendingAction) return;
    setPendingAction(`open:${materialId}`);
    try {
      setSelected(await getTrainingMaterial(accessToken, materialId));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось открыть материал');
    } finally {
      setPendingAction(null);
    }
  };

  const handleRefresh = async () => {
    if (!selected) return;
    await runAction('refresh', () => {
      if (selected.type === 'PDF') {
        if (!refreshFile) throw new Error('Выберите новую версию документа PDF.');
        return refreshTrainingPdfMaterial(accessToken, selected.id, refreshFile);
      }
      if (selected.type === 'MANUAL_TEXT') {
        return refreshTrainingMaterial(accessToken, selected.id, { text: refreshText });
      }
      if (selected.type === 'OBJECT_SNAPSHOT') {
        return refreshTrainingMaterial(accessToken, selected.id, { fieldCodes });
      }
      return refreshTrainingMaterial(accessToken, selected.id, {});
    }, 'Создана новая неизменяемая версия; существующие факты не изменены.');
  };

  const handleApply = async () => {
    if (!selectedRevision || !selectedSuggestions.length || pendingAction) return;
    setPendingAction('apply');
    setError(null);
    setNotice(null);
    try {
      const response = await applyTrainingMaterialSuggestions(
        accessToken,
        selectedRevision.id,
        {
          suggestions: selectedSuggestions.map((suggestion) => ({
            suggestionId: suggestion.id,
            targetQuestionId: suggestion.targetQuestionId,
            statement: suggestion.statement,
            aliases: suggestion.aliases,
            isRequired: suggestion.isRequired,
            sourceLocator: suggestion.sourceLocator,
            sourceExcerpt: suggestion.sourceExcerpt,
          })),
        },
      );
      setNotice(
        `Создано фактов: ${response.createdFactIds.length}. Дубликатов пропущено: ${response.duplicates.length}.`,
      );
      await onProjectContentChanged();
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : 'Не удалось применить предложенные факты');
    } finally {
      setPendingAction(null);
    }
  };

  const handleObjectImport = async (replaceExistingQuestions = false) => {
    if (!selectedObjectId || pendingAction) return;
    setPendingAction('object-import');
    setError(null);
    setNotice(null);
    try {
      const response = await importTrainingObjectContent(accessToken, projectId, {
        objectId: selectedObjectId,
        replaceExistingQuestions,
      });
      const failedSuffix = response.failedPdfTitles.length
        ? ` Не удалось извлечь PDF: ${response.failedPdfTitles.join(', ')}.`
        : '';
      setNotice(
        `ЖК «${response.object.title}» связан с проектом. Карточка и PDF загружены: ${response.importedPdfCount}. Созданы 1 главный и 10 дополнительных вопросов с активными эталонными ответами.${failedSuffix}`,
      );
      setReloadKey((value) => value + 1);
      await onProjectContentChanged();
    } catch (importError) {
      const message = importError instanceof Error ? importError.message : 'Не удалось загрузить данные ЖК';
      if (!replaceExistingQuestions && message === 'PROJECT_QUESTIONS_REPLACE_CONFIRMATION_REQUIRED') {
        setPendingAction(null);
        const confirmed = window.confirm(
          'В проекте уже есть вопросы и эталонные ответы. Заменить их новыми автоматически созданными черновиками из карточки ЖК и вложений?',
        );
        if (confirmed) await handleObjectImport(true);
        return;
      }
      setError(message);
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="training-materials-layout">
      {error ? <AdminAlert tone="error">{error}</AdminAlert> : null}
      {notice ? <AdminAlert tone="notice">{notice}</AdminAlert> : null}
      {disabled ? (
        <AdminAlert tone="notice">Закройте проект перед изменением материалов. Предпросмотр и история доступны для чтения.</AdminAlert>
      ) : null}

      <div className="training-material-workspace">
        <div className="training-material-library-column">
          <Card className="training-object-import-card">
            <CardHeader>
              <CardTitle><Building2Icon /> Данные ЖК из Platforma</CardTitle>
              <CardDescription>
                Найдите ЖК по названию. Поиск понимает текст в другой раскладке. Система сохранит снимок данных карточки, загрузит прикреплённые документы PDF и сформирует 11 вопросов с эталонными ответами.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Field data-disabled={disabled}>
                <FieldLabel htmlFor="training-object-search">Связанный ЖК</FieldLabel>
                <ObjectSearchCombobox
                  disabled={disabled}
                  id="training-object-search"
                  isLoading={isObjectOptionsLoading}
                  onQueryChange={setObjectSearch}
                  onSelectedIdChange={setSelectedObjectId}
                  options={objectOptions}
                  query={objectSearch}
                  selectedId={selectedObjectId}
                />
                <FieldDescription>
                  Загружаются только стабильные поля карточки; цены, акции, остатки и другие изменяемые данные исключены.
                </FieldDescription>
                {objectOptionsError ? <p className="training-object-search-error" role="alert">{objectOptionsError}</p> : null}
              </Field>
            </CardContent>
            <CardFooter>
              <AdminButton
                type="button"
                tone="primary"
                disabled={disabled || !selectedObjectId || Boolean(pendingAction)}
                onClick={() => void handleObjectImport()}
              >
                <SparklesIcon data-icon="inline-start" />
                {pendingAction === 'object-import' ? 'Загрузка и генерация…' : 'Создать вопросы и ответы из данных ЖК'}
              </AdminButton>
            </CardFooter>
          </Card>

          <section className="training-material-browser" aria-labelledby="training-materials-list-title">
            <div className="training-material-browser-heading">
              <div>
                <h3 id="training-materials-list-title">Материалы проекта</h3>
                <p className="muted-text">Все источники, используемые для подготовки вопросов.</p>
              </div>
              <AdminButton
                type="button"
                tone={isCreateOpen ? 'secondary' : 'primary'}
                disabled={disabled}
                aria-expanded={isCreateOpen}
                onClick={() => setIsCreateOpen((value) => {
                  setCreateError(null);
                  return !value;
                })}
              >
                {isCreateOpen ? <XIcon data-icon="inline-start" /> : <PlusIcon data-icon="inline-start" />}
                {isCreateOpen ? 'Закрыть форму' : 'Добавить источник'}
              </AdminButton>
            </div>

            {isCreateOpen ? (
              <Card className="training-material-create-card">
                <CardHeader>
                  <CardTitle>Новый источник</CardTitle>
                <CardDescription>Документы PDF и официальные ссылки формируют вопросы и эталонные ответы. Каждый источник сохраняется отдельной неизменяемой версией.</CardDescription>
                </CardHeader>
                <CardContent>
                  <form onSubmit={(event) => void handleCreate(event)}>
                    <FieldGroup>
                      <Field data-disabled={disabled}>
                        <FieldLabel htmlFor="training-material-type">Тип источника</FieldLabel>
                        <select
                          id="training-material-type"
                          className="training-material-select"
                          value={createType}
                          disabled={disabled}
                          onChange={(event) => {
                            setCreateType(event.target.value as CreatableTrainingMaterialType);
                            setCreateError(null);
                          }}
                        >
                          {creatableMaterialTypes.map((value) => (
                            <option key={value} value={value}>{typeLabels[value]}</option>
                          ))}
                        </select>
                      </Field>
                      <Field data-disabled={disabled} data-invalid={createError?.field === 'title'}>
                        <FieldLabel htmlFor="training-material-title">Название</FieldLabel>
                        <Input
                          id="training-material-title"
                          value={title}
                          disabled={disabled}
                          aria-invalid={createError?.field === 'title'}
                          onChange={(event) => {
                            setTitle(event.target.value);
                            if (createError?.field === 'title') setCreateError(null);
                          }}
                        />
                        {createError?.field === 'title' ? <FieldError>{createError.message}</FieldError> : null}
                      </Field>
                      {createType === 'PDF' ? (
                        <Field data-disabled={disabled} data-invalid={createError?.field === 'file'}>
                          <FieldLabel htmlFor="training-material-pdf">Документ PDF с текстовым слоем</FieldLabel>
                          <Input
                            id="training-material-pdf"
                            type="file"
                            accept="application/pdf,.pdf"
                            disabled={disabled}
                            aria-invalid={createError?.field === 'file'}
                            onChange={(event) => {
                              setFile(event.target.files?.[0] ?? null);
                              if (createError?.field === 'file') setCreateError(null);
                            }}
                          />
                          <FieldDescription>До 25 МБ. Автоматическое распознавание текста и сканы без текстового слоя не поддерживаются.</FieldDescription>
                          {createError?.field === 'file' ? <FieldError>{createError.message}</FieldError> : null}
                        </Field>
                      ) : null}
                      {createType === 'OFFICIAL_URL' ? (
                        <>
                          <Field data-disabled={disabled} data-invalid={createError?.field === 'url'}>
                          <FieldLabel htmlFor="training-material-url">Одна официальная защищённая страница</FieldLabel>
                            <Input
                              id="training-material-url"
                              type="url"
                              value={url}
                              disabled={disabled}
                              aria-invalid={createError?.field === 'url'}
                              onChange={(event) => {
                                setUrl(event.target.value);
                                if (createError?.field === 'url') setCreateError(null);
                              }}
                            />
                            {createError?.field === 'url' ? <FieldError>{createError.message}</FieldError> : null}
                          </Field>
                          <Field
                            orientation="horizontal"
                            className="training-official-confirmation"
                            data-disabled={disabled}
                          >
                            <input
                              id="training-material-official-confirmation"
                              type="checkbox"
                              checked={officialConfirmed}
                              disabled={disabled}
                              onChange={(event) => setOfficialConfirmed(event.target.checked)}
                            />
                            <FieldLabel htmlFor="training-material-official-confirmation">
                              Подтверждаю, что это официальный источник проекта
                            </FieldLabel>
                          </Field>
                        </>
                      ) : null}
                      {createType === 'MANUAL_TEXT' ? (
                        <Field data-disabled={disabled}>
                          <FieldLabel htmlFor="training-material-text">Текст</FieldLabel>
                          <textarea id="training-material-text" className="training-textarea" rows={8} value={text} disabled={disabled} onChange={(event) => setText(event.target.value)} />
                        </Field>
                      ) : null}
                      {createError?.field === 'form' ? <AdminAlert tone="error">{createError.message}</AdminAlert> : null}
                      <AdminButton type="submit" tone="primary" disabled={disabled || pendingAction === 'create' || (createType === 'OFFICIAL_URL' && !officialConfirmed)}>
                        {pendingAction === 'create' ? 'Извлечение…' : 'Создать материал'}
                      </AdminButton>
                    </FieldGroup>
                  </form>
                </CardContent>
              </Card>
            ) : null}

            <div className="training-material-filters">
              <label className="training-material-search">
                <SearchIcon aria-hidden="true" />
                <span className="sr-only">Поиск по материалам</span>
                <Input
                  type="search"
                  value={materialSearch}
                  placeholder="Поиск по материалам"
                  onChange={(event) => setMaterialSearch(event.target.value)}
                />
              </label>
              <select
                className="training-material-select training-material-type-filter"
                aria-label="Фильтр по типу материала"
                value={materialTypeFilter}
                onChange={(event) => setMaterialTypeFilter(event.target.value as 'ALL' | TrainingMaterialType)}
              >
                <option value="ALL">Все типы</option>
                {Object.entries(typeLabels).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>

            {isLoading ? <Skeleton className="training-materials-skeleton" /> : null}
            {!isLoading && materials.length === 0 ? (
              <Empty className="training-material-empty">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia>
                  <EmptyTitle>Источников пока нет</EmptyTitle>
                  <EmptyDescription>Добавьте документ PDF, официальную ссылку, ручной текст или снимок данных связанной карточки.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {!isLoading && materials.length > 0 && visibleMaterials.length === 0 ? (
              <Empty className="training-material-empty">
                <EmptyHeader>
                  <EmptyMedia variant="icon"><SearchIcon /></EmptyMedia>
                  <EmptyTitle>Ничего не найдено</EmptyTitle>
                  <EmptyDescription>Измените запрос или сбросьте фильтр типа.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : null}
            {!isLoading && visibleMaterials.length > 0 ? (
              <div className="training-material-table-shell">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Источник</TableHead>
                      <TableHead>Тип</TableHead>
                      <TableHead>Обновлён</TableHead>
                      <TableHead>Статус</TableHead>
                      <TableHead><span className="sr-only">Открыть</span></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleMaterials.map((material) => (
                      <MaterialRow
                        active={selected?.id === material.id}
                        key={material.id}
                        material={material}
                        onOpen={() => void openMaterial(material.id)}
                      />
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
            <p className="training-material-count">Показано {visibleMaterials.length} из {materials.length}</p>
          </section>
        </div>

        <aside className="training-material-inspector" aria-label="Инспектор выбранного материала">
          {selected ? (
        <Card className="training-material-detail">
          <CardHeader>
            <CardTitle>{selected.title}</CardTitle>
            <CardDescription>{typeLabels[selected.type]} · {formatVersionCount(selected.revisions.length)}</CardDescription>
            <CardAction><Badge variant={selected.status === 'ACTIVE' ? 'secondary' : 'outline'}>{materialStatusLabels[selected.status]}</Badge></CardAction>
          </CardHeader>
          <CardContent className="training-material-detail-content">
            {selectedRevision ? (
              <>
                {selectedRevision.status === 'FAILED' ? (
                  <AdminAlert tone="error">
                    Извлечение не завершено: {formatExtractionError(selectedRevision.extractionMetadata.errorCode)}.
                    Для документа PDF загрузите другой файл с текстовым слоем или добавьте источник как ручной текст; автоматическое распознавание не запускается.
                  </AdminAlert>
                ) : null}
                <div className="training-material-meta">
                  <span>Версия {selectedRevision.revisionNumber}</span>
                  <span>{formatExtractionMethod(selectedRevision.extractionMetadata.method)}</span>
                  <span>{revisionStatusLabels[selectedRevision.status]}</span>
                  <span>{selectedRevision.contentHash.slice(0, 12)}…</span>
                  <span>{selectedRevision.isChanged ? 'Есть изменения' : 'Без изменений'}</span>
                </div>
                {selected.type === 'OFFICIAL_URL' ? (
                  <dl className="training-material-url-meta">
                    <div><dt>Запрошенная ссылка</dt><dd>{selectedRevision.requestedUrl ?? selected.sourceUrl ?? '—'}</dd></div>
                    <div><dt>Итоговая ссылка</dt><dd>{selectedRevision.finalUrl ?? '—'}</dd></div>
                    <div><dt>Загружено</dt><dd>{selectedRevision.fetchedAt ? new Date(selectedRevision.fetchedAt).toLocaleString('ru-RU') : '—'}</dd></div>
                  </dl>
                ) : null}
                {selected.type === 'OBJECT_SNAPSHOT' ? (
                  <dl className="training-material-url-meta">
                    <div><dt>Объект</dt><dd>{String(selectedRevision.extractionMetadata.objectTitle ?? '—')}</dd></div>
                    <div><dt>Идентификатор объекта</dt><dd>{String(selectedRevision.extractionMetadata.objectId ?? '—')}</dd></div>
                    <div><dt>Выбрано полей</dt><dd>{Array.isArray(selectedRevision.extractionMetadata.fieldCodes) ? selectedRevision.extractionMetadata.fieldCodes.length : 0}</dd></div>
                  </dl>
                ) : null}
                <section className="training-material-preview">
                  <h4>Извлечённый текст</h4>
                  {selectedRevision.segments.length ? (
                    <ol className="training-material-segments">
                      {selectedRevision.segments.map((segment) => (
                        <li key={segment.locator}>
                          <div><strong>{segment.label}</strong><span>{formatSegmentLocator(segment.locator)}</span></div>
                          <p>{segment.text}</p>
                        </li>
                      ))}
                    </ol>
                  ) : <p className="muted-text">Извлечённого текста нет.</p>}
                </section>
                <section className="training-material-diff">
                  <h4>Изменения</h4>
                  <div>
                    <span>Добавлено: {selectedRevision.diff.added.length}</span>
                    <span>Удалено: {selectedRevision.diff.removed.length}</span>
                    <span>Без изменений: {selectedRevision.diff.unchangedCount}</span>
                  </div>
                  {selectedRevision.diff.added.length ? <DiffList title="Добавленные фрагменты" items={selectedRevision.diff.added} /> : null}
                  {selectedRevision.diff.removed.length ? <DiffList title="Удалённые фрагменты" items={selectedRevision.diff.removed} /> : null}
                </section>
                <section className="training-material-history">
                  <h4>История версий</h4>
                  <ol>{selected.revisions.map((revision) => (
                    <li key={revision.id}>
                      <button
                        type="button"
                        className={revision.id === selectedRevision.id ? 'training-revision-button training-revision-button--active' : 'training-revision-button'}
                        onClick={() => setSelectedRevisionId(revision.id)}
                      >
                        <strong>#{revision.revisionNumber}</strong>
                        <span>{revisionStatusLabels[revision.status]} · {new Date(revision.createdAt).toLocaleString('ru-RU')}</span>
                        <Badge variant={revision.isChanged ? 'secondary' : 'outline'}>{revision.isChanged ? 'Изменена' : 'Без изменений'}</Badge>
                      </button>
                    </li>
                  ))}</ol>
                </section>
                {selectedRevision.status === 'READY' ? <section className="training-material-suggestions">
                  <div className="training-subsection-heading">
                    <div><h4>Дополнительные факты из материала</h4><p className="muted-text">Можно дополнить автоматически созданные ответы; новые сгенерированные факты не участвуют в публикации до ручного применения.</p></div>
                    <AdminButton type="button" tone="secondary" disabled={disabled || !hasQuestions || Boolean(pendingAction)} onClick={() => void runAction('suggest', () => generateTrainingMaterialSuggestions(accessToken, selectedRevision.id), 'Дополнительные факты сгенерированы и ждут ручного выбора.')}>
                      <SparklesIcon data-icon="inline-start" />
                      {pendingAction === 'suggest' ? 'Генерация…' : 'Сгенерировать дополнительные факты'}
                    </AdminButton>
                  </div>
                  {!hasQuestions ? <p className="muted-text">Сначала создайте вопросы проекта — без них факты не к чему привязать.</p> : suggestionDrafts.length ? suggestionDrafts.map((suggestion, index) => (
                    <SuggestionEditor
                      key={suggestion.id}
                      suggestion={suggestion}
                      selected={selectedSuggestionIds.includes(suggestion.id)}
                      disabled={disabled}
                      onSelected={(checked) => setSelectedSuggestionIds((current) => checked ? [...current, suggestion.id] : current.filter((id) => id !== suggestion.id))}
                      onChange={(next) => setSuggestionDrafts((current) => current.map((item, itemIndex) => itemIndex === index ? next : item))}
                    />
                  )) : <p className="muted-text">Дополнительные факты ещё не сгенерированы.</p>}
                  <AdminButton type="button" tone="primary" disabled={disabled || !hasQuestions || !selectedSuggestions.length || Boolean(pendingAction)} onClick={() => void handleApply()}>
                    Применить выбранные ({selectedSuggestions.length})
                  </AdminButton>
                </section> : null}
              </>
            ) : <p className="muted-text">У материала нет версий.</p>}
          </CardContent>
          <CardFooter className="training-material-actions">
            {selected.type === 'PDF' ? <Input type="file" accept="application/pdf,.pdf" disabled={disabled} onChange={(event) => setRefreshFile(event.target.files?.[0] ?? null)} /> : null}
            {selected.type === 'MANUAL_TEXT' ? <textarea className="training-textarea" rows={5} value={refreshText} disabled={disabled} onChange={(event) => setRefreshText(event.target.value)} /> : null}
            {selected.type === 'OBJECT_SNAPSHOT' ? <ObjectFields disabled={disabled} value={fieldCodes} onChange={setFieldCodes} /> : null}
            <div className="training-toolbar">
              <AdminButton type="button" tone="secondary" disabled={disabled || Boolean(pendingAction)} onClick={() => void handleRefresh()}>
                <RefreshCwIcon data-icon="inline-start" /> Новая версия
              </AdminButton>
              {selected.type === 'PDF' ? <AdminButton type="button" tone="text" onClick={() => void downloadTrainingMaterialPdf(accessToken, selected.id, selected.title)}><DownloadIcon data-icon="inline-start" /> Скачать исходный файл</AdminButton> : null}
              <AdminButton type="button" tone="danger" disabled={disabled || selected.status === 'ARCHIVED' || Boolean(pendingAction)} onClick={() => void runAction('archive', () => archiveTrainingMaterial(accessToken, selected.id), 'Материал архивирован без удаления истории.')}><ArchiveIcon data-icon="inline-start" /> Архивировать</AdminButton>
            </div>
          </CardFooter>
        </Card>
          ) : (
            <Empty className="training-material-inspector-empty">
              <EmptyHeader>
                <EmptyMedia variant="icon"><FileTextIcon /></EmptyMedia>
                <EmptyTitle>Выберите источник</EmptyTitle>
                <EmptyDescription>Здесь появятся содержимое, версии и действия выбранного материала.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </aside>
      </div>
    </div>
  );
}

function ObjectSearchCombobox({
  disabled,
  id,
  isLoading,
  onQueryChange,
  onSelectedIdChange,
  options,
  query,
  selectedId,
}: {
  disabled: boolean;
  id: string;
  isLoading: boolean;
  onQueryChange: (value: string) => void;
  onSelectedIdChange: (value: string) => void;
  options: TrainingObjectOption[];
  query: string;
  selectedId: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = `${id}-results`;
  const selected = options.find((option) => option.id === selectedId) ?? null;

  const selectOption = (option: TrainingObjectOption) => {
    onSelectedIdChange(option.id);
    onQueryChange('');
    setIsOpen(false);
    inputRef.current?.focus();
  };
  const clearSelection = () => {
    onSelectedIdChange('');
    onQueryChange('');
    inputRef.current?.focus();
  };
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsOpen(false);
    onQueryChange('');
  };
  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setIsOpen(false);
      onQueryChange('');
      return;
    }
    if (event.key === 'Enter' && isOpen && options[0]) {
      event.preventDefault();
      selectOption(options[0]);
      return;
    }
    if (event.key === 'Backspace' && !query && selectedId) clearSelection();
  };

  return (
    <div className="searchable-multi-select training-object-search" onBlur={handleBlur}>
      <div
        className={isOpen ? 'searchable-multi-select-control is-open' : 'searchable-multi-select-control'}
        data-disabled={disabled}
        onClick={() => {
          if (disabled) return;
          setIsOpen(true);
          inputRef.current?.focus();
        }}
      >
        <div className="searchable-multi-select-value">
          {selected ? (
            <button
              className="searchable-multi-select-chip"
              type="button"
              disabled={disabled}
              aria-label={`Убрать ${selected.title}`}
              onClick={(event) => {
                event.stopPropagation();
                clearSelection();
              }}
            >
              <span className="training-object-selected-copy">
                <strong>{selected.title}</strong>
                <small>{formatObjectOptionMeta(selected)}</small>
              </span>
              <XIcon aria-hidden="true" />
            </button>
          ) : null}
          <input
            id={id}
            ref={inputRef}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={isOpen}
            aria-label="Поиск ЖК"
            role="combobox"
            type="search"
            value={query}
            disabled={disabled}
            placeholder={selected ? '' : 'Введите название ЖК'}
            onChange={(event) => {
              onQueryChange(event.currentTarget.value);
              setIsOpen(true);
            }}
            onFocus={() => setIsOpen(true)}
            onKeyDown={handleInputKeyDown}
          />
        </div>
        {selected ? (
          <button
            className="searchable-multi-select-clear"
            type="button"
            disabled={disabled}
            aria-label="Очистить выбранный ЖК"
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
      {isOpen && !disabled ? (
        <div id={listboxId} className="searchable-multi-select-menu" role="listbox" aria-busy={isLoading}>
          {options.length ? options.map((option) => (
            <button
              key={option.id}
              className={option.id === selectedId
                ? 'searchable-multi-select-option searchable-multi-select-option--selected'
                : 'searchable-multi-select-option'}
              type="button"
              role="option"
              aria-selected={option.id === selectedId}
              onClick={() => selectOption(option)}
            >
              <span>
                <strong>{option.title}</strong>
                <small>{formatObjectOptionMeta(option)}</small>
              </span>
              {option.id === selectedId ? <span className="searchable-multi-select-check">Выбрано</span> : null}
            </button>
          )) : (
            <p className="searchable-multi-select-empty">
              {isLoading ? 'Поиск…' : 'ЖК не найдены'}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function mergeObjectOptions(
  options: TrainingObjectOption[],
  ...additional: Array<TrainingObjectOption | null>
) {
  const byId = new Map(options.map((option) => [option.id, option]));
  for (const option of additional) {
    if (option) byId.set(option.id, option);
  }
  return [...byId.values()];
}

function formatVersionCount(value: number) {
  const mod100 = value % 100;
  const mod10 = value % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${value} версий`;
  if (mod10 === 1) return `${value} версия`;
  if (mod10 >= 2 && mod10 <= 4) return `${value} версии`;
  return `${value} версий`;
}

function formatExtractionMethod(value: unknown) {
  const method = typeof value === 'string' ? value : '';
  return ({
    MANUAL: 'Ручной текст',
    PDF_TEXT_LAYER: 'Текстовый слой PDF',
    HTTP: 'Загрузка страницы',
    BROWSER: 'Загрузка через браузер',
    OBJECT_SNAPSHOT: 'Карточка Platforma',
    PDF: 'Документ PDF',
  } as Record<string, string>)[method] ?? 'Способ не указан';
}

function formatExtractionError(value: unknown) {
  const code = typeof value === 'string' ? value : '';
  return ({
    PDF_TEXT_LAYER_MISSING: 'в документе нет текстового слоя',
    MATERIAL_EXTRACTION_FAILED: 'не удалось извлечь текст',
  } as Record<string, string>)[code] ?? 'неизвестная ошибка извлечения';
}

function formatObjectOptionMeta(option: TrainingObjectOption) {
  return [option.developerName, objectStatusLabels[option.status], `${option.pdfCount} PDF`]
    .filter(Boolean)
    .join(' · ');
}

function formatSegmentLocator(locator: string) {
  const [kind, value] = locator.split(':', 2);
  if (kind === 'page' && value) return `Страница ${value}`;
  if (kind === 'paragraph' && value) return `Абзац ${value}`;
  if (kind === 'object-field') return 'Поле карточки';
  return 'Фрагмент источника';
}

function formatMaterialCreateError(error: unknown) {
  const message = error instanceof Error ? error.message : 'Не удалось создать материал';

  if (message === 'QUESTION_DRAFT_GENERATION_FAILED' || message === 'Internal server error') {
    return 'Не удалось сформировать вопросы по источнику. Материал не сохранён. Попробуйте ещё раз.';
  }

  return message;
}

function MaterialRow({ active, material, onOpen }: { active: boolean; material: TrainingMaterial; onOpen: () => void }) {
  const Icon = typeIcons[material.type];
  return (
    <TableRow className="training-material-row" data-state={active ? 'selected' : undefined}>
      <TableCell>
        <button type="button" className="training-material-title-button" onClick={onOpen}>
          <span className="training-material-type-icon"><Icon aria-hidden="true" /></span>
          <span>
            <strong>{material.title}</strong>
            <small>Версия {material.latestRevision?.revisionNumber ?? 0}</small>
          </span>
        </button>
      </TableCell>
      <TableCell><Badge variant="outline">{typeLabels[material.type]}</Badge></TableCell>
      <TableCell>{new Date(material.updatedAt).toLocaleDateString('ru-RU')}</TableCell>
      <TableCell>
        <Badge variant={material.latestRevision?.status === 'FAILED' ? 'destructive' : 'secondary'}>
          {material.latestRevision ? revisionStatusLabels[material.latestRevision.status] : 'Нет версии'}
        </Badge>
      </TableCell>
      <TableCell>
        <button type="button" className="training-material-open-button" aria-label={`Открыть ${material.title}`} onClick={onOpen}>
          <ChevronRightIcon aria-hidden="true" />
        </button>
      </TableCell>
    </TableRow>
  );
}

function DiffList({ items, title }: { items: string[]; title: string }) {
  return (
    <div className="training-material-diff-list">
      <strong>{title}</strong>
      <ul>{items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>
    </div>
  );
}

function ObjectFields({ disabled, onChange, value }: { disabled: boolean; onChange: (value: string[]) => void; value: string[] }) {
  return (
    <fieldset className="training-object-fields" disabled={disabled}>
      <legend>Разрешённые поля карточки</legend>
      <div>{objectFields.map(([code, label]) => (
        <label key={code}>
          <input type="checkbox" checked={value.includes(code)} onChange={(event) => onChange(event.target.checked ? [...value, code] : value.filter((item) => item !== code))} />
          {label}
        </label>
      ))}</div>
    </fieldset>
  );
}

function SuggestionEditor({
  disabled,
  onChange,
  onSelected,
  selected,
  suggestion,
}: {
  disabled: boolean;
  onChange: (value: TrainingMaterialSuggestion) => void;
  onSelected: (value: boolean) => void;
  selected: boolean;
  suggestion: TrainingMaterialSuggestion;
}) {
  return (
    <article className="training-suggestion-editor">
      <label className="training-inline-check">
        <input type="checkbox" checked={selected} disabled={disabled} onChange={(event) => onSelected(event.target.checked)} />
        Выбрать предложенный факт
      </label>
      <FieldGroup>
        <Field data-disabled={disabled}>
          <FieldLabel htmlFor={`suggestion-statement-${suggestion.id}`}>Факт</FieldLabel>
          <textarea id={`suggestion-statement-${suggestion.id}`} className="training-textarea" rows={3} value={suggestion.statement} disabled={disabled} onChange={(event) => onChange({ ...suggestion, statement: event.target.value })} />
        </Field>
        <Field data-disabled={disabled}>
          <FieldLabel htmlFor={`suggestion-aliases-${suggestion.id}`}>Варианты ответа</FieldLabel>
          <Input id={`suggestion-aliases-${suggestion.id}`} value={suggestion.aliases.join(', ')} disabled={disabled} onChange={(event) => onChange({ ...suggestion, aliases: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} />
        </Field>
      </FieldGroup>
      <blockquote><strong>{formatSegmentLocator(suggestion.sourceLocator)}</strong> · {suggestion.sourceExcerpt}</blockquote>
    </article>
  );
}
