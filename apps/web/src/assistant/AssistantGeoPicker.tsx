import type { AssistantGeoSearchContext } from '@platforma/shared';
import { CrosshairIcon, MapPinIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

import { PlatformMap, type MapCoordinate, type MapStatus, type MapViewport } from '../map/PlatformMap';

type AssistantGeoPickerProps = {
  initialGeo: AssistantGeoSearchContext | null;
  onCancel: () => void;
  onConfirm: (geo: AssistantGeoSearchContext) => void;
};

const presetKilometers = [1, 2, 3, 5];
const defaultCenter: MapCoordinate = [55.751244, 37.618423];

export function AssistantGeoPicker({ initialGeo, onCancel, onConfirm }: AssistantGeoPickerProps) {
  const initialCenter = useMemo<MapCoordinate>(() => initialGeo
    ? [initialGeo.anchor.latitude, initialGeo.anchor.longitude]
    : defaultCenter, [initialGeo]);
  const [center, setCenter] = useState<MapCoordinate>(initialCenter);
  const [radiusKilometers, setRadiusKilometers] = useState(
    initialGeo ? String(initialGeo.radiusMeters / 1_000) : '2',
  );
  const [mapStatus, setMapStatus] = useState<MapStatus>('loading');
  const radiusMeters = parseRadiusKilometers(radiusKilometers);

  const handleViewportChange = (viewport: MapViewport) => {
    setCenter(viewport.center);
  };

  return (
    <section className="assistant-geo-picker" aria-label="Выбор точки и радиуса" data-assistant-geo-picker>
      <div className="assistant-geo-picker-heading">
        <div>
          <strong>Точка поиска</strong>
          <span>Двигайте карту под прицелом. Поиск начнётся только после подтверждения.</span>
        </div>
        <MapPinIcon aria-hidden="true" />
      </div>

      <div className="assistant-geo-picker-map">
        <PlatformMap
          ariaLabel="Карта выбора точки"
          enableFullscreen={false}
          enableMeasurement={false}
          initialViewport={{ center: initialCenter, zoom: 13 }}
          points={[]}
          renderWithoutPoints
          onStatusChange={setMapStatus}
          onViewportChange={handleViewportChange}
        >
          <div className="assistant-geo-crosshair" aria-hidden="true">
            <CrosshairIcon />
          </div>
        </PlatformMap>
      </div>

      <div className="assistant-geo-coordinate-row">
        <label>
          Широта
          <input
            inputMode="decimal"
            value={formatCoordinate(center[0])}
            onChange={(event) => setCenter(([_, longitude]) => [clampCoordinate(event.target.value, -90, 90, center[0]), longitude])}
          />
        </label>
        <label>
          Долгота
          <input
            inputMode="decimal"
            value={formatCoordinate(center[1])}
            onChange={(event) => setCenter(([latitude]) => [latitude, clampCoordinate(event.target.value, -180, 180, center[1])])}
          />
        </label>
      </div>
      {mapStatus === 'error' || mapStatus === 'disabled' ? (
        <p className="assistant-geo-map-note" role="status">
          Подложка недоступна — координаты можно ввести вручную.
        </p>
      ) : null}

      <fieldset className="assistant-geo-radius">
        <legend>Радиус по прямой</legend>
        <div className="assistant-geo-radius-presets">
          {presetKilometers.map((kilometers) => (
            <button
              aria-pressed={radiusMeters === kilometers * 1_000}
              key={kilometers}
              type="button"
              onClick={() => setRadiusKilometers(String(kilometers))}
            >
              {kilometers} км
            </button>
          ))}
        </div>
        <label className="assistant-geo-custom-radius">
          Другой радиус, км
          <input
            aria-invalid={radiusMeters === null}
            inputMode="decimal"
            maxLength={6}
            value={radiusKilometers}
            onChange={(event) => setRadiusKilometers(event.target.value)}
          />
        </label>
        {radiusMeters === null ? <span role="alert">Введите от 0,1 до 20 км.</span> : null}
      </fieldset>

      <div className="assistant-geo-picker-actions">
        <button type="button" onClick={onCancel}>Отмена</button>
        <button
          data-assistant-geo-confirm
          disabled={radiusMeters === null}
          type="button"
          onClick={() => radiusMeters && onConfirm({
            anchor: {
              latitude: center[0],
              longitude: center[1],
              label: 'Точка на карте',
              source: 'MANUAL',
            },
            radiusMeters,
          })}
        >
          Подтвердить точку
        </button>
      </div>
    </section>
  );
}

function parseRadiusKilometers(value: string) {
  const parsed = Number(value.trim().replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 20) return null;
  return Math.round(parsed * 1_000);
}

function clampCoordinate(value: string, minimum: number, maximum: number, fallback: number) {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function formatCoordinate(value: number) {
  return String(Number(value.toFixed(6)));
}
