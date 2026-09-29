import { type FormEvent, type Ref, useEffect, useMemo, useRef, useState } from 'react';
import { DownloadIcon, XIcon } from 'lucide-react';
import {
  LOT_PRESENTATION_FINISH_TYPES,
  type LotPresentationFinishType,
  type LotPresentationUnitFinish,
} from '@platforma/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FieldError } from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

const finishSegmentLabels: Record<LotPresentationFinishType, { title: string; hint: string }> = {
  ROUGH: { title: 'Черновая', hint: 'бетон' },
  FINE: { title: 'Предчистовая', hint: 'вайт-бокс' },
  WITH_FINISH: { title: 'Чистовая', hint: 'дизайнерская' },
};

export type LotFinishSelectionModalLot = {
  id: string;
  title: string;
  projectTitle: string;
};

type LotFinishSelectionModalProps = {
  error: string | null;
  isLoading: boolean;
  lots: LotFinishSelectionModalLot[];
  onCancel: () => void;
  onSubmit: (unitFinishes: LotPresentationUnitFinish[]) => void;
};

export function LotFinishSelectionModal({
  error,
  isLoading,
  lots,
  onCancel,
  onSubmit,
}: LotFinishSelectionModalProps) {
  const [selectedFinishes, setSelectedFinishes] = useState<Record<string, LotPresentationFinishType>>({});
  const firstOptionRef = useRef<HTMLButtonElement>(null);
  const lotIdsKey = useMemo(() => lots.map((lot) => lot.id).join('|'), [lots]);
  const selectedCount = lots.reduce((count, lot) => count + (selectedFinishes[lot.id] ? 1 : 0), 0);
  const isComplete = lots.length > 0 && selectedCount === lots.length;
  const firstLotFinish = lots[0] ? selectedFinishes[lots[0].id] : undefined;
  const commonFinish = firstLotFinish && lots.every((lot) => selectedFinishes[lot.id] === firstLotFinish) ? firstLotFinish : '';

  useEffect(() => {
    setSelectedFinishes({});
  }, [lotIdsKey]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!isComplete || isLoading) {
      return;
    }

    onSubmit(
      lots.map((lot) => ({
        unitId: lot.id,
        finishType: selectedFinishes[lot.id]!,
      })),
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(isOpen) => {
        if (!isOpen && !isLoading) {
          onCancel();
        }
      }}
    >
      <DialogContent
        aria-busy={isLoading}
        className="lot-finish-modal"
        overlayClassName="lot-finish-modal-backdrop"
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (isLoading) {
            event.preventDefault();
          }
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          firstOptionRef.current?.focus();
        }}
        onPointerDownOutside={(event) => {
          if (isLoading) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader className="lot-finish-modal-header">
          <div className="lot-finish-modal-heading">
            <p className="eyebrow">Подготовка PDF</p>
            <DialogTitle>Укажите отделку в лоте</DialogTitle>
            <DialogDescription>
              Выберите отдельный вариант для каждого жилого лота. Он будет показан в презентации.
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              aria-label="Закрыть выбор отделки"
              className="lot-finish-modal-close"
              disabled={isLoading}
              size="icon-lg"
              type="button"
              variant="outline"
            >
              <XIcon aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>

        <form className="lot-finish-modal-form" onSubmit={handleSubmit}>
          <div className="lot-finish-modal-list">
            {lots.length > 1 ? (
              <div className="lot-finish-modal-row lot-finish-modal-row--all">
                <div className="lot-finish-modal-lot-heading">
                  <span className="lot-finish-modal-lot-title">Для всех лотов</span>
                  <span className="lot-finish-modal-all-hint">Применить один вариант сразу</span>
                </div>
                <FinishSegments
                  disabled={isLoading}
                  firstItemRef={firstOptionRef}
                  label="Отделка для всех лотов"
                  value={commonFinish}
                  onChange={(finishType) =>
                    setSelectedFinishes(Object.fromEntries(lots.map((lot) => [lot.id, finishType])))
                  }
                />
              </div>
            ) : null}
            {lots.map((lot, lotIndex) => (
              <div className="lot-finish-modal-row" key={lot.id}>
                <div className="lot-finish-modal-lot-heading">
                  <span className="lot-finish-modal-lot-title">{lot.title}</span>
                  <span className="lot-finish-modal-project-title">{lot.projectTitle}</span>
                </div>
                <FinishSegments
                  disabled={isLoading}
                  firstItemRef={lotIndex === 0 && lots.length === 1 ? firstOptionRef : undefined}
                  label={`Отделка для ${lot.title}`}
                  value={selectedFinishes[lot.id] ?? ''}
                  onChange={(finishType) =>
                    setSelectedFinishes((currentFinishes) => ({
                      ...currentFinishes,
                      [lot.id]: finishType,
                    }))
                  }
                />
              </div>
            ))}
          </div>

          <DialogFooter className="lot-finish-modal-footer">
            <div className="lot-finish-modal-progress" aria-live="polite">
              <strong>{selectedCount} из {lots.length}</strong>
              <span>лотов заполнено</span>
            </div>
            {error ? <FieldError className="lot-finish-modal-error">{error}</FieldError> : null}
            <div className="lot-finish-modal-actions">
              <DialogClose asChild>
                <Button disabled={isLoading} size="lg" type="button" variant="outline">
                  Отмена
                </Button>
              </DialogClose>
              <Button
                disabled={!isComplete || isLoading}
                size="lg"
                type="submit"
              >
                <DownloadIcon aria-hidden="true" data-icon="inline-start" />
                {isLoading ? 'Формируем PDF…' : 'Сформировать PDF'}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FinishSegments({
  disabled,
  firstItemRef,
  label,
  value,
  onChange,
}: {
  disabled: boolean;
  firstItemRef?: Ref<HTMLButtonElement>;
  label: string;
  value: LotPresentationFinishType | '';
  onChange: (finishType: LotPresentationFinishType) => void;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      className="lot-finish-modal-segments"
      disabled={disabled}
      spacing={0}
      type="single"
      value={value}
      onValueChange={(finishType) => {
        // A single toggle group reports '' when the active item is clicked again; a finish stays required.
        if (finishType) {
          onChange(finishType as LotPresentationFinishType);
        }
      }}
    >
      {LOT_PRESENTATION_FINISH_TYPES.map((finishType, finishIndex) => (
        <ToggleGroupItem
          ref={finishIndex === 0 ? firstItemRef : undefined}
          className="lot-finish-modal-segment"
          key={finishType}
          value={finishType}
        >
          <span className="lot-finish-modal-segment-title">{finishSegmentLabels[finishType].title}</span>
          <span className="lot-finish-modal-segment-hint">{finishSegmentLabels[finishType].hint}</span>
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
