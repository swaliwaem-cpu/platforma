import { ChevronDownIcon } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import {
  DropdownContent,
  DropdownRoot,
  DropdownTrigger,
  joinDropdownClassNames,
  useDropdownState,
  type DropdownCloseReason,
} from './Dropdown';

/*
 * Filter pill (approved catalog variant A): a 36px chip that opens a shared dropdown
 * menu and turns dark with its value once a filter is set. Used by the catalog and
 * the lots of an object page.
 */

export function FilterPill({
  ariaLabel,
  children,
  disabled = false,
  isSet,
  label,
  menuClassName,
  value,
}: {
  ariaLabel: string;
  children: (close: (reason: DropdownCloseReason) => void) => ReactNode;
  disabled?: boolean;
  isSet: boolean;
  label: string;
  menuClassName?: string;
  value: string;
}) {
  const menuId = useId();
  const { isOpen, open, close, onOpenChange } = useDropdownState();
  const showsValue = isSet && Boolean(value);
  const showsKey = showsValue && !label.startsWith('Все ');

  return (
    <DropdownRoot open={isOpen && !disabled} onOpenChange={onOpenChange}>
      <DropdownTrigger aria-controls={isOpen ? menuId : undefined} aria-haspopup="dialog" onOpen={open}>
        <button
          aria-expanded={isOpen}
          className={joinDropdownClassNames('catalog-filter-pill', showsValue && 'is-set', isOpen && 'is-open')}
          disabled={disabled}
          title={showsValue ? `${ariaLabel}: ${value}` : ariaLabel}
          type="button"
        >
          {showsKey ? <span className="catalog-filter-pill-key">{label}</span> : null}
          <span className="catalog-filter-pill-value">{showsValue ? value : label}</span>
          <ChevronDownIcon aria-hidden="true" className="catalog-filter-pill-chevron" />
        </button>
      </DropdownTrigger>

      <DropdownContent id={menuId} aria-label={ariaLabel} className={menuClassName} onRequestClose={close}>
        {children(close)}
      </DropdownContent>
    </DropdownRoot>
  );
}

export function FilterPopoverFooter({ onClear, onDone }: { onClear: () => void; onDone: () => void }) {
  return (
    <div className="catalog-filter-popover-footer">
      <button className="catalog-filter-popover-clear" type="button" onClick={onClear}>
        Очистить
      </button>
      <button className="catalog-filter-popover-done" type="button" onClick={onDone}>
        Готово
      </button>
    </div>
  );
}

export function formatPillSelection(labels: string[]) {
  const [firstLabel] = labels;

  if (!firstLabel) {
    return '';
  }

  return labels.length > 1 ? `${firstLabel} +${labels.length - 1}` : firstLabel;
}

export function formatCompactMoney(value: string) {
  const amount = Number(value);

  if (!Number.isFinite(amount)) {
    return value;
  }

  const format = (number: number) => number.toLocaleString('ru-RU', { maximumFractionDigits: 1 });

  if (amount >= 1_000_000) {
    return `${format(amount / 1_000_000)} млн`;
  }

  if (amount >= 1_000) {
    return `${format(amount / 1_000)} тыс`;
  }

  return format(amount);
}

export function formatRangeValue(min: string, max: string, formatValue: (value: string) => string) {
  if (min && max) {
    return `${formatValue(min)} – ${formatValue(max)}`;
  }

  if (min) {
    return `от ${formatValue(min)}`;
  }

  return max ? `до ${formatValue(max)}` : '';
}
