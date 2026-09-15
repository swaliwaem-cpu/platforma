import { ChevronDownIcon } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import {
  DropdownContent,
  DropdownEmpty,
  DropdownListbox,
  DropdownOption,
  DropdownRoot,
  DropdownSearchInput,
  DropdownTrigger,
  joinDropdownClassNames,
  matchesDropdownQuery,
  useDropdownState,
  type DropdownCloseReason,
} from './Dropdown';

export type SelectDropdownOption<Value extends string = string> = {
  value: Value;
  label: string;
  description?: string;
  disabled?: boolean;
  searchValues?: Array<string | null | undefined>;
};

type SelectDropdownProps<Value extends string> = {
  id?: string;
  ariaLabel?: string;
  autoFocus?: boolean;
  className?: string;
  defaultOpen?: boolean;
  disabled?: boolean;
  emptyLabel?: string;
  emptyValue?: string;
  filterOption?: (option: SelectDropdownOption<Value>, query: string) => boolean;
  menuClassName?: string;
  options: ReadonlyArray<SelectDropdownOption<Value>>;
  placeholder?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  value: string;
  onChange: (value: Value) => void;
  onClose?: (reason: DropdownCloseReason) => void;
};

/** Single-value dropdown that replaces the native select element across the platform. */
export function SelectDropdown<Value extends string>({
  id,
  ariaLabel,
  autoFocus,
  className,
  defaultOpen = false,
  disabled = false,
  emptyLabel = 'Ничего не найдено',
  emptyValue = '',
  filterOption,
  menuClassName,
  options,
  placeholder = 'Не выбрано',
  searchable = false,
  searchPlaceholder = 'Поиск',
  value,
  onChange,
  onClose,
}: SelectDropdownProps<Value>) {
  const generatedId = useId();
  const triggerId = id ?? `${generatedId}-trigger`;
  const listboxId = `${generatedId}-listbox`;
  const [query, setQuery] = useState('');
  const { isOpen, open, close, onOpenChange } = useDropdownState({
    defaultOpen,
    onClose: (reason) => {
      setQuery('');
      onClose?.(reason);
    },
  });
  const selectedOption = options.find((option) => option.value === value);
  const isEmpty = !selectedOption || selectedOption.value === emptyValue;
  const filteredOptions = useMemo(
    () =>
      searchable
        ? options.filter((option) =>
            filterOption
              ? filterOption(option, query)
              : matchesDropdownQuery(query, option.searchValues ?? [option.label, option.description]),
          )
        : options,
    [filterOption, options, query, searchable],
  );
  const firstEnabledOption = filteredOptions.find((option) => !option.disabled);

  function selectOption(option: SelectDropdownOption<Value>) {
    if (option.disabled) {
      return;
    }

    if (option.value === value) {
      close('dismiss');
      return;
    }

    onChange(option.value);
    close('select');
  }

  return (
    <DropdownRoot open={isOpen && !disabled} onOpenChange={onOpenChange}>
      <DropdownTrigger aria-controls={isOpen ? listboxId : undefined} onOpen={open}>
        <button
          id={triggerId}
          aria-expanded={isOpen}
          aria-label={ariaLabel}
          autoFocus={autoFocus}
          className={joinDropdownClassNames(
            'multi-select-dropdown-button',
            'select-dropdown',
            isOpen && 'is-open',
            className,
          )}
          disabled={disabled}
          role="combobox"
          type="button"
        >
          <span className={isEmpty ? 'multi-select-dropdown-value is-empty' : 'multi-select-dropdown-value'}>
            {selectedOption?.label ?? placeholder}
          </span>
          <ChevronDownIcon aria-hidden="true" className="multi-select-dropdown-chevron" />
        </button>
      </DropdownTrigger>

      <DropdownContent className={menuClassName} onRequestClose={close}>
        {searchable ? (
          <DropdownSearchInput
            aria-controls={listboxId}
            aria-label={ariaLabel ? `${ariaLabel}: поиск` : searchPlaceholder}
            placeholder={searchPlaceholder}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && firstEnabledOption) {
                event.preventDefault();
                selectOption(firstEnabledOption);
              }
            }}
          />
        ) : null}
        <DropdownListbox id={listboxId} aria-labelledby={triggerId}>
          {filteredOptions.length > 0 ? (
            filteredOptions.map((option) => (
              <DropdownOption
                key={option.value}
                description={option.description}
                disabled={option.disabled}
                label={option.label}
                selected={option.value === value}
                onSelect={() => selectOption(option)}
              />
            ))
          ) : (
            <DropdownEmpty>{emptyLabel}</DropdownEmpty>
          )}
        </DropdownListbox>
      </DropdownContent>
    </DropdownRoot>
  );
}
