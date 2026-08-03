import {
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { CheckIcon, ChevronDownIcon, SearchIcon } from 'lucide-react';
import type { TrainingAdminResultSummary, TrainingAdminResultsQuery } from '@platforma/shared';

import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

import { AdminAlert, AdminButton, AdminEmptyState, AdminPanel, AdminStatusBadge } from '../admin/AdminUi';
import { useAuth } from '../auth/AuthProvider';
import { getTrainingAdminResults } from './trainingApi';
import {
  formatTrainingDate,
  formatTrainingDuration,
  getTrainingStatusClass,
  trainingAnswerSourceLabels,
  trainingAssignmentStatusLabels,
  trainingAttemptStatusLabels,
  trainingReviewStatusLabels,
} from './trainingView';

const initialQuery: TrainingAdminResultsQuery = {
  page: 1,
  limit: 20,
  search: '',
  userId: '',
  projectId: '',
  accessMode: '',
  assignmentStatus: '',
  startedFrom: '',
  startedTo: '',
  attemptStatus: '',
  reviewStatus: '',
  passed: '',
  scoreMin: '',
  scoreMax: '',
  durationMin: '',
  durationMax: '',
  source: '',
  sort: 'STARTED_DESC',
};

type TrainingAdminResultsPageProps = { navigate: (pathname: string) => void };
type TrainingResultEmployee = TrainingAdminResultSummary['user'];

export function TrainingAdminResultsPage({ navigate }: TrainingAdminResultsPageProps) {
  const { accessToken } = useAuth();
  const [draft, setDraft] = useState(initialQuery);
  const [query, setQuery] = useState(initialQuery);
  const [items, setItems] = useState<TrainingAdminResultSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [employeeInput, setEmployeeInput] = useState('');
  const [selectedEmployee, setSelectedEmployee] = useState<TrainingResultEmployee | null>(null);
  const [employeeOptions, setEmployeeOptions] = useState<TrainingResultEmployee[]>([]);
  const [isEmployeeOpen, setIsEmployeeOpen] = useState(false);
  const [isEmployeeLoading, setIsEmployeeLoading] = useState(false);
  const [employeeError, setEmployeeError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    void getTrainingAdminResults(accessToken, query, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        setItems(response.items);
        setTotal(response.total);
        setTotalPages(response.totalPages);
      })
      .catch((loadError: unknown) => {
        if (!controller.signal.aborted) {
          setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить результаты');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [accessToken, query, reloadKey]);

  useEffect(() => {
    if (!accessToken || !isEmployeeOpen) return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => {
      setIsEmployeeLoading(true);
      setEmployeeError(null);

      void getTrainingAdminResults(
        accessToken,
        {
          ...initialQuery,
          limit: 50,
          search: employeeInput.trim(),
        },
        controller.signal,
      )
        .then((response) => {
          if (controller.signal.aborted) return;
          setEmployeeOptions(uniqueEmployees(response.items, selectedEmployee));
        })
        .catch((loadError: unknown) => {
          if (controller.signal.aborted) return;
          setEmployeeOptions(selectedEmployee ? [selectedEmployee] : []);
          setEmployeeError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить сотрудников');
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsEmployeeLoading(false);
        });
    }, 180);

    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [accessToken, employeeInput, isEmployeeOpen, selectedEmployee]);

  const update = <Key extends keyof TrainingAdminResultsQuery>(
    key: Key,
    value: TrainingAdminResultsQuery[Key],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };
  const applyFilters = (event: FormEvent) => {
    event.preventDefault();
    setIsEmployeeOpen(false);
    setQuery({ ...draft, page: 1 });
  };
  const resetFilters = () => {
    setEmployeeInput('');
    setSelectedEmployee(null);
    setEmployeeOptions([]);
    setIsEmployeeOpen(false);
    setEmployeeError(null);
    setDraft(initialQuery);
    setQuery(initialQuery);
  };
  const setPage = (page: number) => {
    const next = { ...query, page };
    setDraft(next);
    setQuery(next);
  };

  return (
    <div className="training-page training-admin-page training-results-page">
      <header className="training-page-header">
        <div>
          <p className="eyebrow">Админка · Обучение</p>
          <h2>Результаты сотрудников</h2>
          <p className="muted-text">Найдите сотрудника и откройте нужную попытку.</p>
        </div>
        <AdminButton type="button" tone="secondary" onClick={() => navigate('/admin/training')}>
          К проектам
        </AdminButton>
      </header>

      <AdminPanel className="training-results-filter-panel">
        <form onSubmit={applyFilters}>
          <FieldGroup className="training-results-filters">
            <Field>
              <FieldLabel htmlFor="training-result-employee">Сотрудник</FieldLabel>
              <EmployeeFilterCombobox
                id="training-result-employee"
                inputValue={employeeInput}
                isLoading={isEmployeeLoading}
                isOpen={isEmployeeOpen}
                loadError={employeeError}
                options={employeeOptions}
                selectedEmployee={selectedEmployee}
                onInputChange={(value) => {
                  setEmployeeInput(value);
                  setSelectedEmployee(null);
                  setEmployeeOptions([]);
                  setEmployeeError(null);
                  setIsEmployeeLoading(true);
                  update('search', value);
                  update('userId', '');
                }}
                onOpenChange={(isOpen) => {
                  setIsEmployeeOpen(isOpen);
                  if (isOpen) setIsEmployeeLoading(true);
                }}
                onSelect={(employee) => {
                  setSelectedEmployee(employee);
                  setEmployeeInput(employee.name ?? employee.email);
                  setIsEmployeeOpen(false);
                  setEmployeeError(null);
                  update('search', '');
                  update('userId', employee.id);
                }}
              />
            </Field>
            <SelectField
              id="training-result-status"
              label="Статус"
              value={draft.attemptStatus}
              onChange={(value) => update(
                'attemptStatus',
                value as TrainingAdminResultsQuery['attemptStatus'],
              )}
              options={[
                ['', 'Все статусы'],
                ['IN_PROGRESS', 'В процессе'],
                ['COMPLETED', 'Завершена'],
                ['REQUIRES_REVIEW', 'Требует проверки'],
                ['TIMED_OUT', 'Время истекло'],
                ['TECHNICAL_FAILED', 'Техническая ошибка'],
              ]}
            />
          </FieldGroup>
          <div className="training-results-filter-actions">
            <AdminButton type="submit" tone="primary">Показать</AdminButton>
            <AdminButton type="button" tone="secondary" onClick={resetFilters}>Сбросить</AdminButton>
          </div>
        </form>
      </AdminPanel>

      {error ? (
        <AdminAlert tone="error">
          <span>{error}</span>
          <AdminButton type="button" tone="text" onClick={() => setReloadKey((value) => value + 1)}>
            Повторить
          </AdminButton>
        </AdminAlert>
      ) : null}
      <div className="training-section-heading">
        <div className="training-results-heading-copy">
          <h3>Найденные попытки</h3>
          <span className="training-section-count">{total}</span>
        </div>
        <span className="training-results-sort-note">Сначала новые</span>
      </div>
      {isLoading ? (
        <Skeleton className="training-list-skeleton" />
      ) : items.length ? (
        <AdminPanel className="training-results-table-panel">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Сотрудник / проект</TableHead>
                <TableHead>Статус</TableHead>
                <TableHead>Результат</TableHead>
                <TableHead>Длительность</TableHead>
                <TableHead>Текущий доступ</TableHead>
                <TableHead>Старт</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <ResultRow
                  key={item.id}
                  item={item}
                  open={() => navigate(`/admin/training/attempts/${item.id}`)}
                />
              ))}
            </TableBody>
          </Table>
        </AdminPanel>
      ) : (
        <AdminEmptyState
          title="Результаты не найдены"
          description="Измените фильтры или дождитесь новых попыток."
        />
      )}
      <div className="training-results-pagination">
        <AdminButton
          type="button"
          tone="secondary"
          disabled={query.page <= 1 || isLoading}
          onClick={() => setPage(query.page - 1)}
        >
          Назад
        </AdminButton>
        <span>Страница {query.page} из {Math.max(1, totalPages)}</span>
        <AdminButton
          type="button"
          tone="secondary"
          disabled={query.page >= totalPages || isLoading}
          onClick={() => setPage(query.page + 1)}
        >
          Далее
        </AdminButton>
      </div>
    </div>
  );
}

function EmployeeFilterCombobox({
  id,
  inputValue,
  isLoading,
  isOpen,
  loadError,
  onInputChange,
  onOpenChange,
  onSelect,
  options,
  selectedEmployee,
}: {
  id: string;
  inputValue: string;
  isLoading: boolean;
  isOpen: boolean;
  loadError: string | null;
  onInputChange: (value: string) => void;
  onOpenChange: (isOpen: boolean) => void;
  onSelect: (employee: TrainingResultEmployee) => void;
  options: TrainingResultEmployee[];
  selectedEmployee: TrainingResultEmployee | null;
}) {
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = `${id}-results`;
  const highlightedEmployee = options[highlightedIndex] ?? null;

  const open = () => {
    onOpenChange(true);
    setHighlightedIndex(0);
  };
  const selectEmployee = (employee: TrainingResultEmployee) => {
    onSelect(employee);
    setHighlightedIndex(0);
    inputRef.current?.focus();
  };
  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    onOpenChange(false);
  };
  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      onOpenChange(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!isOpen) open();
      else setHighlightedIndex((current) => Math.min(current + 1, Math.max(0, options.length - 1)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!isOpen) open();
      else setHighlightedIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (event.key === 'Home' && isOpen && options.length) {
      event.preventDefault();
      setHighlightedIndex(0);
      return;
    }
    if (event.key === 'End' && isOpen && options.length) {
      event.preventDefault();
      setHighlightedIndex(options.length - 1);
      return;
    }
    if (event.key === 'Enter' && isOpen && highlightedEmployee) {
      event.preventDefault();
      selectEmployee(highlightedEmployee);
    }
  };

  return (
    <div className="searchable-multi-select training-results-employee-select" onBlur={handleBlur}>
      <div
        className={cn('searchable-multi-select-control', isOpen && 'is-open')}
        onClick={() => {
          open();
          inputRef.current?.focus();
        }}
      >
        <SearchIcon className="training-results-employee-search-icon" aria-hidden="true" />
        <div className="searchable-multi-select-value">
          <input
            id={id}
            ref={inputRef}
            aria-activedescendant={
              isOpen && highlightedEmployee ? `${listboxId}-${highlightedEmployee.id}` : undefined
            }
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={isOpen}
            aria-haspopup="listbox"
            autoComplete="off"
            role="combobox"
            type="search"
            value={inputValue}
            placeholder="Имя или электронная почта"
            onChange={(event) => {
              onInputChange(event.currentTarget.value);
              open();
            }}
            onFocus={() => {
              if (!isOpen) open();
            }}
            onKeyDown={handleInputKeyDown}
          />
        </div>
        <ChevronDownIcon className="searchable-multi-select-chevron" aria-hidden="true" />
      </div>
      {isOpen ? (
        <div
          id={listboxId}
          className="searchable-multi-select-menu"
          role="listbox"
          aria-busy={isLoading}
        >
          {options.length ? (
            options.map((employee, index) => {
              const isSelected = employee.id === selectedEmployee?.id;
              const isHighlighted = index === highlightedIndex;

              return (
                <button
                  id={`${listboxId}-${employee.id}`}
                  key={employee.id}
                  className={cn(
                    'searchable-multi-select-option',
                    isSelected && 'searchable-multi-select-option--selected',
                    isHighlighted && 'searchable-multi-select-option--highlighted',
                  )}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={isSelected}
                  onClick={() => selectEmployee(employee)}
                  onMouseMove={() => setHighlightedIndex(index)}
                >
                  <span className="training-results-employee-option-copy">
                    <strong>{employee.name ?? employee.email}</strong>
                    <small>{employee.email}</small>
                  </span>
                  {isSelected ? <CheckIcon aria-hidden="true" /> : null}
                </button>
              );
            })
          ) : (
            <p className="searchable-multi-select-empty">
              {isLoading
                ? 'Поиск…'
                : loadError
                  ? 'Не удалось загрузить сотрудников'
                  : 'Сотрудники не найдены'}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function uniqueEmployees(
  items: TrainingAdminResultSummary[],
  selectedEmployee: TrainingResultEmployee | null,
) {
  const byId = new Map<string, TrainingResultEmployee>();
  if (selectedEmployee) byId.set(selectedEmployee.id, selectedEmployee);
  for (const item of items) byId.set(item.user.id, item.user);

  return [...byId.values()].sort((left, right) =>
    (left.name ?? left.email).localeCompare(right.name ?? right.email, 'ru'),
  );
}

function ResultRow({ item, open }: { item: TrainingAdminResultSummary; open: () => void }) {
  return (
    <TableRow>
      <TableCell>
        <strong>{item.user.name ?? item.user.email}</strong>
        <small className="training-table-secondary">
          {item.user.email} · {item.project.title} · №{item.attemptNumber}
        </small>
      </TableCell>
      <TableCell>
        <AdminStatusBadge className={getTrainingStatusClass(item.status)}>
          {trainingAttemptStatusLabels[item.status]}
        </AdminStatusBadge>
        <small className="training-table-secondary">
          {trainingReviewStatusLabels[item.reviewStatus]}
        </small>
      </TableCell>
      <TableCell>
        {item.finalScore ?? '—'} / 100
        <small className="training-table-secondary">
          {item.isPassed === null ? 'Итог не подтверждён' : item.isPassed ? 'Пройдено' : 'Не пройдено'}
        </small>
      </TableCell>
      <TableCell>
        {formatTrainingDuration(item.durationSeconds)}
        <small className="training-table-secondary">
          {item.answerCount} ответов · {item.answerSources.map((source) =>
            trainingAnswerSourceLabels[source]).join(', ') || '—'}
        </small>
      </TableCell>
      <TableCell>
        {item.currentAccess.hasCurrentAccess ? 'Есть' : 'Нет'}
        <small className="training-table-secondary">
          {trainingAssignmentStatusLabels[item.currentAccess.assignmentStatus]}
        </small>
      </TableCell>
      <TableCell>{formatTrainingDate(item.startedAt)}</TableCell>
      <TableCell><AdminButton type="button" tone="secondary" onClick={open}>Открыть</AdminButton></TableCell>
    </TableRow>
  );
}

function SelectField({
  id,
  label,
  onChange,
  options,
  value,
}: {
  id: string;
  label: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
  value: string;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select
        id={id}
        className="training-select"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue || 'all'} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
    </Field>
  );
}
