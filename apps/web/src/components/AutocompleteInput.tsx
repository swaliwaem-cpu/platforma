import { useId, useMemo, useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import {
  DropdownAnchor,
  DropdownContent,
  DropdownListbox,
  DropdownOption,
  DropdownRoot,
  matchesDropdownQuery,
} from './Dropdown';

export type AutocompleteSuggestion = {
  key: string;
  value: string;
  description?: string;
  searchValues?: Array<string | null | undefined>;
};

const autocompleteSuggestionLimit = 40;

/** Free-text input with suggestions in the platform dropdown style (replaces the native datalist popup). */
export function AutocompleteInput({
  id,
  placeholder,
  suggestions,
  value,
  onChange,
}: {
  id?: string;
  placeholder?: string;
  suggestions: AutocompleteSuggestion[];
  value: string;
  onChange: (value: string) => void;
}) {
  const listboxId = useId();
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const filteredSuggestions = useMemo(() => {
    const seenValues = new Set<string>();

    return suggestions
      .filter((suggestion) => {
        if (!suggestion.value || seenValues.has(suggestion.value)) {
          return false;
        }

        seenValues.add(suggestion.value);

        return matchesDropdownQuery(value, suggestion.searchValues ?? [suggestion.value, suggestion.description]);
      })
      .slice(0, autocompleteSuggestionLimit);
  }, [suggestions, value]);
  const isMenuOpen = isOpen && filteredSuggestions.length > 0;

  function selectSuggestion(suggestion: AutocompleteSuggestion) {
    onChange(suggestion.value);
    setIsOpen(false);
    inputRef.current?.focus();
  }

  function isInsideAnchor(target: EventTarget | null) {
    return target instanceof Node && Boolean(anchorRef.current?.contains(target));
  }

  return (
    <DropdownRoot open={isMenuOpen} onOpenChange={setIsOpen}>
      <DropdownAnchor asChild>
        <div ref={anchorRef} className="autocomplete-input">
          <Input
            ref={inputRef}
            id={id}
            aria-autocomplete="list"
            aria-controls={isMenuOpen ? listboxId : undefined}
            aria-expanded={isMenuOpen}
            autoComplete="off"
            placeholder={placeholder}
            role="combobox"
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              setIsOpen(true);
            }}
            onClick={() => setIsOpen(true)}
            onFocus={() => setIsOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setIsOpen(true);
                window.requestAnimationFrame(() =>
                  document.getElementById(listboxId)?.querySelector<HTMLElement>('[role="option"]')?.focus(),
                );
              }

              if (event.key === 'Escape' && isMenuOpen) {
                event.preventDefault();
                setIsOpen(false);
              }
            }}
          />
        </div>
      </DropdownAnchor>

      <DropdownContent
        autoFocusOnOpen={false}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={() => inputRef.current?.focus()}
        onFocusOutside={(event) => {
          if (isInsideAnchor(event.target)) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          if (isInsideAnchor(event.target)) {
            event.preventDefault();
          }
        }}
        onRequestClose={() => setIsOpen(false)}
      >
        <DropdownListbox id={listboxId}>
          {filteredSuggestions.map((suggestion) => (
            <DropdownOption
              key={suggestion.key}
              description={suggestion.description}
              label={suggestion.value}
              selected={suggestion.value === value}
              onSelect={() => selectSuggestion(suggestion)}
            />
          ))}
        </DropdownListbox>
      </DropdownContent>
    </DropdownRoot>
  );
}
