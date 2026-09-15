import { matchesSearchVariants } from '@platforma/shared/search-normalization';
import { CheckIcon } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useCallback, useRef, useState, type ComponentProps, type KeyboardEvent, type ReactNode } from 'react';

/*
 * Shared building blocks for every platform dropdown. The menu is rendered in a
 * portal (Radix Popover), so it is never clipped by tables, dialogs or panels
 * with overflow, and it always carries the reference "Сколько комнат" look:
 * .multi-select-dropdown-menu / -list / -option.
 */

export type DropdownCloseReason = 'select' | 'escape' | 'dismiss';

export const DropdownRoot = Popover.Root;
export const DropdownAnchor = Popover.Anchor;

export function useDropdownState({
  defaultOpen = false,
  onClose,
}: {
  defaultOpen?: boolean;
  onClose?: (reason: DropdownCloseReason) => void;
} = {}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const isOpenRef = useRef(defaultOpen);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const open = useCallback(() => {
    isOpenRef.current = true;
    setIsOpen(true);
  }, []);

  const close = useCallback((reason: DropdownCloseReason) => {
    if (!isOpenRef.current) {
      return;
    }

    isOpenRef.current = false;
    setIsOpen(false);
    onCloseRef.current?.(reason);
  }, []);

  const onOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        open();
      } else {
        close('dismiss');
      }
    },
    [close, open],
  );

  return { isOpen, open, close, onOpenChange };
}

export function joinDropdownClassNames(...classNames: Array<string | false | null | undefined>) {
  return classNames.filter(Boolean).join(' ');
}

export function DropdownTrigger({
  children,
  onOpen,
  ...props
}: ComponentProps<typeof Popover.Trigger> & { onOpen: () => void }) {
  return (
    <Popover.Trigger
      aria-haspopup="listbox"
      {...props}
      onKeyDown={(event) => {
        props.onKeyDown?.(event);

        if (!event.defaultPrevented && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
          event.preventDefault();
          onOpen();
        }
      }}
      asChild
    >
      {children}
    </Popover.Trigger>
  );
}

export function DropdownContent({
  autoFocusOnOpen = true,
  children,
  className,
  onEscapeKeyDown,
  onRequestClose,
  ...props
}: ComponentProps<typeof Popover.Content> & {
  autoFocusOnOpen?: boolean;
  onRequestClose?: (reason: DropdownCloseReason) => void;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);

  return (
    <Popover.Portal>
      <Popover.Content
        align="start"
        collisionPadding={12}
        role="presentation"
        side="bottom"
        sideOffset={6}
        {...props}
        ref={contentRef}
        className={joinDropdownClassNames('multi-select-dropdown-menu', className)}
        onEscapeKeyDown={(event) => {
          onEscapeKeyDown?.(event);
          onRequestClose?.('escape');
        }}
        onKeyDown={(event) => {
          props.onKeyDown?.(event);

          if (!event.defaultPrevented) {
            handleDropdownKeyDown(event, onRequestClose);
          }
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();

          if (autoFocusOnOpen && contentRef.current) {
            focusInitialDropdownItem(contentRef.current);
          }
        }}
      >
        {children}
      </Popover.Content>
    </Popover.Portal>
  );
}

export function DropdownSearchInput(props: ComponentProps<'input'>) {
  return (
    <input
      autoComplete="off"
      type="search"
      {...props}
      className={joinDropdownClassNames('multi-select-dropdown-search', props.className)}
      data-dropdown-search=""
    />
  );
}

export function DropdownListbox(props: ComponentProps<'div'>) {
  return <div role="listbox" {...props} className={joinDropdownClassNames('multi-select-dropdown-list', props.className)} />;
}

export function DropdownOption({
  description,
  disabled = false,
  id,
  label,
  selected,
  onSelect,
}: {
  description?: ReactNode;
  disabled?: boolean;
  id?: string;
  label: ReactNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      id={id}
      aria-selected={selected}
      className={joinDropdownClassNames('multi-select-dropdown-option', selected && 'multi-select-dropdown-option--selected')}
      disabled={disabled}
      role="option"
      type="button"
      onClick={onSelect}
    >
      {description ? (
        <span className="multi-select-dropdown-option-copy">
          <span>{label}</span>
          <small>{description}</small>
        </span>
      ) : (
        <span>{label}</span>
      )}
      {selected ? <CheckIcon aria-hidden="true" className="multi-select-dropdown-check" /> : null}
    </button>
  );
}

export function DropdownEmpty({ children }: { children: ReactNode }) {
  return <p className="multi-select-dropdown-empty">{children}</p>;
}

/** Same normalized matching as the catalog filters: case, ё/е and keyboard layout insensitive. */
export function matchesDropdownQuery(query: string, values: Array<string | null | undefined>) {
  return matchesSearchVariants(query, values);
}

function getDropdownOptions(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled)'));
}

function focusDropdownItem(item: HTMLElement | null | undefined) {
  if (!item) {
    return;
  }

  item.focus({ preventScroll: true });
  scrollDropdownItemIntoView(item);
}

function scrollDropdownItemIntoView(item: HTMLElement) {
  const list = item.closest<HTMLElement>('.multi-select-dropdown-list');

  if (!list || item.getAttribute('role') !== 'option') {
    return;
  }

  const itemTop = item.offsetTop;
  const itemBottom = itemTop + item.offsetHeight;

  if (itemTop < list.scrollTop) {
    list.scrollTop = itemTop;
  } else if (itemBottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = itemBottom - list.clientHeight;
  }
}

function focusInitialDropdownItem(container: HTMLElement) {
  const searchInput = container.querySelector<HTMLInputElement>('[data-dropdown-search]');

  if (searchInput) {
    searchInput.focus({ preventScroll: true });
    return;
  }

  const selectedOption = container.querySelector<HTMLElement>('[role="option"][aria-selected="true"]:not(:disabled)');
  const option = selectedOption ?? getDropdownOptions(container)[0];

  if (!option) {
    const firstField = container.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)');
    (firstField ?? container).focus({ preventScroll: true });
    return;
  }

  option.focus({ preventScroll: true });
  window.requestAnimationFrame(() => scrollDropdownItemIntoView(option));
}

let typeaheadBuffer = '';
let typeaheadTimer = 0;

function handleDropdownKeyDown(
  event: KeyboardEvent<HTMLDivElement>,
  onRequestClose?: (reason: DropdownCloseReason) => void,
) {
  const container = event.currentTarget;
  const options = getDropdownOptions(container);
  const searchInput = container.querySelector<HTMLInputElement>('[data-dropdown-search]');
  const activeElement = document.activeElement as HTMLElement | null;
  const activeIndex = activeElement ? options.indexOf(activeElement) : -1;
  const isOptionFocused = activeIndex !== -1;

  if (options.length === 0) {
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    focusDropdownItem(activeIndex === -1 ? options[0] : options[Math.min(activeIndex + 1, options.length - 1)]);
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();

    if (activeIndex <= 0 && searchInput) {
      searchInput.focus({ preventScroll: true });
      return;
    }

    focusDropdownItem(activeIndex === -1 ? options[options.length - 1] : options[Math.max(activeIndex - 1, 0)]);
    return;
  }

  // Arrow keys above move between options; everything below only applies while an option has focus,
  // so text fields and buttons inside a popover keep their native Tab/Home/End behaviour.
  if (!isOptionFocused) {
    return;
  }

  if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    focusDropdownItem(event.key === 'Home' ? options[0] : options[options.length - 1]);
    return;
  }

  if (event.key === 'Tab') {
    event.preventDefault();
    onRequestClose?.('dismiss');
    return;
  }

  if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey && event.key !== ' ') {
    window.clearTimeout(typeaheadTimer);
    typeaheadBuffer += event.key.toLocaleLowerCase('ru');
    typeaheadTimer = window.setTimeout(() => {
      typeaheadBuffer = '';
    }, 600);

    const match = options.find((option) => option.textContent?.trim().toLocaleLowerCase('ru').startsWith(typeaheadBuffer));

    if (match) {
      event.preventDefault();
      focusDropdownItem(match);
    }
  }
}
