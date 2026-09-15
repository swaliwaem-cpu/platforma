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

export type MultiSelectDropdownOption = {
  value: string;
  label: string;
  description?: string;
  searchValues?: Array<string | null | undefined>;
};

type MultiSelectDropdownProps = {
  ariaLabel: string;
  className?: string;
  defaultOpen?: boolean;
  disabled?: boolean;
  emptyLabel?: string;
  filterOption?: (option: MultiSelectDropdownOption, query: string) => boolean;
  options: MultiSelectDropdownOption[];
  placeholder: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  values: string[];
  onChange: (values: string[]) => void;
  onClose?: (reason: DropdownCloseReason) => void;
};

export function MultiSelectDropdown({
  ariaLabel,
  className,
  defaultOpen = false,
  disabled = false,
  emptyLabel = 'Ничего не найдено',
  filterOption,
  options,
  placeholder,
  searchable = false,
  searchPlaceholder = 'Поиск',
  values,
  onChange,
  onClose,
}: MultiSelectDropdownProps) {
  const listboxId = useId();
  const [query, setQuery] = useState('');
  const { isOpen, open, close, onOpenChange } = useDropdownState({
    defaultOpen,
    onClose: (reason) => {
      setQuery('');
      onClose?.(reason);
    },
  });
  const selectedValueSet = useMemo(() => new Set(values), [values]);
  const selectedOptions = options.filter((option) => selectedValueSet.has(option.value));
  const buttonLabel = selectedOptions.length > 0 ? selectedOptions.map((option) => option.label).join(', ') : placeholder;
  const filteredOptions = useMemo(() => {
    if (!searchable) {
      return options;
    }

    return options.filter((option) =>
      filterOption
        ? filterOption(option, query)
        : matchesDropdownQuery(query, option.searchValues ?? [option.label, option.description]),
    );
  }, [filterOption, options, query, searchable]);

  function changeValues(nextValues: string[]) {
    const nextValueSet = new Set(nextValues);
    onChange(options.filter((option) => nextValueSet.has(option.value)).map((option) => option.value));
  }

  function toggleValue(value: string) {
    const nextValueSet = new Set(values);

    if (nextValueSet.has(value)) {
      nextValueSet.delete(value);
    } else {
      nextValueSet.add(value);
    }

    changeValues([...nextValueSet]);
  }

  function clearValues() {
    changeValues([]);
  }

  return (
    <div className={joinDropdownClassNames('multi-select-dropdown', className)}>
      <DropdownRoot open={isOpen && !disabled} onOpenChange={onOpenChange}>
        <DropdownTrigger aria-controls={isOpen ? listboxId : undefined} onOpen={open}>
          <button
            aria-expanded={isOpen}
            aria-label={ariaLabel}
            className={isOpen ? 'multi-select-dropdown-button is-open' : 'multi-select-dropdown-button'}
            disabled={disabled}
            type="button"
          >
            <span className={selectedOptions.length > 0 ? 'multi-select-dropdown-value' : 'multi-select-dropdown-value is-empty'}>
              {buttonLabel}
            </span>
            <ChevronDownIcon aria-hidden="true" className="multi-select-dropdown-chevron" />
          </button>
        </DropdownTrigger>

        <DropdownContent onRequestClose={close}>
          {searchable ? (
            <DropdownSearchInput
              aria-controls={listboxId}
              aria-label={`${ariaLabel}: поиск`}
              placeholder={searchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && filteredOptions[0]) {
                  event.preventDefault();
                  toggleValue(filteredOptions[0].value);
                }
              }}
            />
          ) : null}
          <DropdownListbox id={listboxId} aria-label={ariaLabel} aria-multiselectable={true}>
            <DropdownOption label={placeholder} selected={selectedOptions.length === 0} onSelect={clearValues} />

            {filteredOptions.length > 0 ? (
              filteredOptions.map((option) => (
                <DropdownOption
                  key={option.value}
                  description={option.description}
                  label={option.label}
                  selected={selectedValueSet.has(option.value)}
                  onSelect={() => toggleValue(option.value)}
                />
              ))
            ) : (
              <DropdownEmpty>{emptyLabel}</DropdownEmpty>
            )}
          </DropdownListbox>
        </DropdownContent>
      </DropdownRoot>
    </div>
  );
}
