import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { DownloadIcon, XIcon } from 'lucide-react';
import {
  LOT_PRESENTATION_FINISH_LABELS,
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
import {
  Field,
  FieldContent,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from '@/components/ui/field';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

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
            {lots.map((lot, lotIndex) => (
              <FieldSet className="lot-finish-modal-lot" disabled={isLoading} key={lot.id}>
                <FieldLegend className="lot-finish-modal-lot-heading" variant="label">
                  <span className="lot-finish-modal-lot-title">{lot.title}</span>
                  <span className="lot-finish-modal-project-title">{lot.projectTitle}</span>
                </FieldLegend>
                <RadioGroup
                  aria-label={`Отделка для ${lot.title}`}
                  className="lot-finish-modal-options"
                  disabled={isLoading}
                  value={selectedFinishes[lot.id]}
                  onValueChange={(finishType) =>
                    setSelectedFinishes((currentFinishes) => ({
                      ...currentFinishes,
                      [lot.id]: finishType as LotPresentationFinishType,
                    }))
                  }
                >
                  {LOT_PRESENTATION_FINISH_TYPES.map((finishType, finishIndex) => {
                    const inputId = `lot-finish-${lotIndex}-${finishType.toLowerCase()}`;

                    return (
                      <FieldLabel
                        className="lot-finish-modal-option"
                        htmlFor={inputId}
                        key={finishType}
                      >
                        <Field orientation="horizontal">
                          <RadioGroupItem
                            ref={lotIndex === 0 && finishIndex === 0 ? firstOptionRef : undefined}
                            id={inputId}
                            value={finishType}
                          />
                          <FieldContent>
                            <FieldTitle className="lot-finish-modal-option-title">
                              {LOT_PRESENTATION_FINISH_LABELS[finishType]}
                            </FieldTitle>
                          </FieldContent>
                        </Field>
                      </FieldLabel>
                    );
                  })}
                </RadioGroup>
              </FieldSet>
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
