import { CheckIcon, ChevronDownIcon, LoaderCircleIcon, XIcon } from 'lucide-react';
import {
  type FocusEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { AdminButton } from '../admin/AdminUi';

export type TrainingSearchPickerOption = {
  id: string;
  label: string;
  description?: string;
  meta?: string;
  disabled?: boolean;
};

export function TrainingSearchPicker({
  id,
  label,
  placeholder,
  emptyLabel,
  options,
  selectedOptions,
  multiple = false,
  disabled = false,
  loading = false,
  error = null,
  hasMore = false,
  query,
  onQueryChange,
  onSelectedOptionsChange,
  onLoadMore,
  onRetry,
}: {
  id: string;
  label: string;
  placeholder: string;
  emptyLabel: string;
  options: TrainingSearchPickerOption[];
  selectedOptions: TrainingSearchPickerOption[];
  multiple?: boolean;
  disabled?: boolean;
  loading?: boolean;
  error?: string | null;
  hasMore?: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onSelectedOptionsChange: (options: TrainingSearchPickerOption[]) => void;
  onLoadMore?: () => void;
  onRetry?: () => void;
}) {
  const generatedId = useId().replace(/:/gu, '');
  const listboxId = `${id}-${generatedId}-listbox`;
  const stateId = `${id}-${generatedId}-state`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const selectedIds = useMemo(
    () => new Set(selectedOptions.map((option) => option.id)),
    [selectedOptions],
  );
  const enabledIndexes = useMemo(
    () =>
      options.flatMap((option, index) =>
        option.disabled ? [] : [index],
      ),
    [options],
  );

  useEffect(() => {
    setActiveIndex((current) =>
      current >= 0 && options[current] && !options[current]?.disabled
        ? current
        : enabledIndexes[0] ?? -1,
    );
  }, [enabledIndexes, options]);

  function toggleOption(option: TrainingSearchPickerOption) {
    if (option.disabled) return;

    if (!multiple) {
      onSelectedOptionsChange([option]);
      onQueryChange('');
      setOpen(false);
      inputRef.current?.focus();
      return;
    }

    onSelectedOptionsChange(
      selectedIds.has(option.id)
        ? selectedOptions.filter((selected) => selected.id !== option.id)
        : [...selectedOptions, option],
    );
    onQueryChange('');
    setOpen(true);
    inputRef.current?.focus();
  }

  function removeOption(optionId: string) {
    onSelectedOptionsChange(
      selectedOptions.filter((option) => option.id !== optionId),
    );
    inputRef.current?.focus();
  }

  function moveActive(direction: 1 | -1) {
    if (enabledIndexes.length === 0) return;
    const currentPosition = enabledIndexes.indexOf(activeIndex);
    const nextPosition =
      currentPosition < 0
        ? direction === 1
          ? 0
          : enabledIndexes.length - 1
        : (currentPosition + direction + enabledIndexes.length) %
          enabledIndexes.length;
    setActiveIndex(enabledIndexes[nextPosition] ?? -1);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        setOpen(false);
      }
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    if (event.key === 'Home' || event.key === 'End') {
      if (!open || enabledIndexes.length === 0) return;
      event.preventDefault();
      setActiveIndex(
        event.key === 'Home'
          ? (enabledIndexes[0] ?? -1)
          : (enabledIndexes[enabledIndexes.length - 1] ?? -1),
      );
      return;
    }

    if (event.key === 'Enter' && open && activeIndex >= 0) {
      const option = options[activeIndex];
      if (!option || option.disabled) return;
      event.preventDefault();
      toggleOption(option);
      return;
    }
    if (event.key === 'Enter' && !open) {
      event.preventDefault();
      setOpen(true);
      return;
    }

    if (
      event.key === 'Backspace' &&
      !query &&
      selectedOptions.length > 0
    ) {
      removeOption(selectedOptions[selectedOptions.length - 1]!.id);
    }
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setOpen(false);
  }

  return (
    <div className="training-search-picker" onBlur={handleBlur}>
      <label className="training-picker-label" htmlFor={id}>
        {label}
      </label>
      <div
        className={[
          'training-picker-control',
          open ? 'is-open' : '',
          disabled ? 'is-disabled' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        onMouseDown={(event) => {
          if (
            disabled ||
            (event.target instanceof Element &&
              event.target.closest('button'))
          ) {
            return;
          }
          event.preventDefault();
          inputRef.current?.focus();
          setOpen(true);
        }}
      >
        <div className="training-picker-value">
          {selectedOptions.map((option) => (
            <span className="training-picker-chip" key={option.id}>
              <span>{option.label}</span>
              {!disabled ? (
                <button
                  type="button"
                  aria-label={`Убрать ${option.label}`}
                  onClick={() => removeOption(option.id)}
                >
                  <XIcon aria-hidden="true" />
                </button>
              ) : null}
            </span>
          ))}
          <input
            ref={inputRef}
            id={id}
            type="search"
            role="combobox"
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? stateId : undefined}
            aria-activedescendant={
              open && activeIndex >= 0
                ? `${listboxId}-option-${activeIndex}`
                : undefined
            }
            autoComplete="off"
            disabled={disabled}
            value={query}
            placeholder={selectedOptions.length === 0 ? placeholder : ''}
            onChange={(event) => {
              onQueryChange(event.currentTarget.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <ChevronDownIcon className="training-picker-chevron" aria-hidden="true" />
      </div>

      {open && !disabled ? (
        <div className="training-picker-popover" aria-busy={loading}>
          <div
            id={listboxId}
            className="training-picker-options"
            role="listbox"
            aria-label={label}
            aria-multiselectable={multiple ? true : undefined}
          >
            {options.map((option, index) => {
              const selected = selectedIds.has(option.id);
              const active = index === activeIndex;
              return (
                <button
                  key={option.id}
                  id={`${listboxId}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  aria-disabled={option.disabled || undefined}
                  className={[
                    'training-picker-option',
                    selected ? 'is-selected' : '',
                    active ? 'is-active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  disabled={option.disabled}
                  onMouseMove={() => {
                    if (!option.disabled) setActiveIndex(index);
                  }}
                  onClick={() => toggleOption(option)}
                >
                  <span className="training-picker-option-copy">
                    <strong>{option.label}</strong>
                    {option.description ? <span>{option.description}</span> : null}
                    {option.meta ? <small>{option.meta}</small> : null}
                  </span>
                  {selected ? <CheckIcon aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>

          {loading ? (
            <div id={stateId} className="training-picker-state" role="status">
              <LoaderCircleIcon className="training-spin" aria-hidden="true" />
              Загружаем…
            </div>
          ) : error ? (
            <div id={stateId} className="training-picker-state" role="alert">
              <span>{error}</span>
              {onRetry ? (
                <AdminButton tone="text" onClick={onRetry}>
                  Повторить
                </AdminButton>
              ) : null}
            </div>
          ) : options.length === 0 ? (
            <div id={stateId} className="training-picker-state" role="status">
              {emptyLabel}
            </div>
          ) : hasMore && onLoadMore ? (
            <div className="training-picker-more">
              <AdminButton tone="text" onClick={onLoadMore}>
                Показать ещё
              </AdminButton>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
