import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { useId, useMemo, useState, type FocusEvent, type KeyboardEvent } from 'react';

export type MultiSelectDropdownOption = {
  value: string;
  label: string;
};

type MultiSelectDropdownProps = {
  ariaLabel: string;
  options: MultiSelectDropdownOption[];
  placeholder: string;
  values: string[];
  onChange: (values: string[]) => void;
};

export function MultiSelectDropdown({
  ariaLabel,
  options,
  placeholder,
  values,
  onChange,
}: MultiSelectDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const listboxId = useId();
  const selectedValueSet = useMemo(() => new Set(values), [values]);
  const selectedOptions = options.filter((option) => selectedValueSet.has(option.value));
  const buttonLabel = selectedOptions.length > 0 ? selectedOptions.map((option) => option.label).join(', ') : placeholder;

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

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }

    setIsOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      setIsOpen(false);
    }
  }

  return (
    <div className="multi-select-dropdown" onBlur={handleBlur} onKeyDown={handleKeyDown}>
      <button
        aria-controls={isOpen ? listboxId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        className={isOpen ? 'multi-select-dropdown-button is-open' : 'multi-select-dropdown-button'}
        type="button"
        onClick={() => setIsOpen((currentValue) => !currentValue)}
      >
        <span className={selectedOptions.length > 0 ? 'multi-select-dropdown-value' : 'multi-select-dropdown-value is-empty'}>
          {buttonLabel}
        </span>
        <ChevronDownIcon aria-hidden="true" className="multi-select-dropdown-chevron" />
      </button>

      {isOpen ? (
        <div id={listboxId} className="multi-select-dropdown-menu" role="listbox" aria-multiselectable={true}>
          <button
            className={
              selectedOptions.length === 0
                ? 'multi-select-dropdown-option multi-select-dropdown-option--selected'
                : 'multi-select-dropdown-option'
            }
            type="button"
            role="option"
            aria-selected={selectedOptions.length === 0}
            onClick={clearValues}
          >
            <span>{placeholder}</span>
            {selectedOptions.length === 0 ? <CheckIcon aria-hidden="true" className="multi-select-dropdown-check" /> : null}
          </button>

          {options.map((option) => {
            const isSelected = selectedValueSet.has(option.value);

            return (
              <button
                key={option.value}
                className={
                  isSelected
                    ? 'multi-select-dropdown-option multi-select-dropdown-option--selected'
                    : 'multi-select-dropdown-option'
                }
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => toggleValue(option.value)}
              >
                <span>{option.label}</span>
                {isSelected ? <CheckIcon aria-hidden="true" className="multi-select-dropdown-check" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
