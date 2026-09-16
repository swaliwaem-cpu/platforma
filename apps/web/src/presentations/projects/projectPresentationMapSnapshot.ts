import { useEffect, useState } from 'react';
import mapLibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import {
  PROJECT_PRESENTATION_MAP_SIZE,
  PROJECT_PRESENTATION_MAP_VIEW,
  type ProjectPresentationMapMarker,
} from '@platforma/shared/project-presentation-template';

import { resolveMapRuntimeConfig } from '../../map/mapContract';
import { localizeOpenMapTilesLabels } from '../../map/openMapTilesLabelLocalization';

export type ProjectPresentationMapPoint = { latitude: number; longitude: number };
export type ProjectPresentationMapSnapshot = {
  imageSrc: string;
  markers: ProjectPresentationMapMarker[];
};

const renderDelayMs = 400;
const renderTimeoutMs = 20_000;

// Renders the preview basemap offscreen with the same camera rules as the PDF generator,
// so the editor shows where the projects land. Returns null while loading or when maps are off.
export function useProjectPresentationMapSnapshot(points: ProjectPresentationMapPoint[]) {
  const pointsKey = JSON.stringify(points.map(({ latitude, longitude }) => [latitude, longitude]));
  const [snapshot, setSnapshot] = useState<{ key: string; value: ProjectPresentationMapSnapshot } | null>(null);

  useEffect(() => {
    const config = resolveMapRuntimeConfig(window.__PLATFORMA_RUNTIME_CONFIG__ ?? {});

    if (!config.enabled) {
      return undefined;
    }

    const coordinates = (JSON.parse(pointsKey) as Array<[number, number]>)
      .map(([latitude, longitude]) => [longitude, latitude] as [number, number]);
    let isCancelled = false;
    let removeMap: (() => void) | null = null;
    const container = window.document.createElement('div');
    container.setAttribute('aria-hidden', 'true');
    Object.assign(container.style, {
      height: `${PROJECT_PRESENTATION_MAP_SIZE.height}px`,
      left: '-10000px',
      pointerEvents: 'none',
      position: 'fixed',
      top: '0',
      width: `${PROJECT_PRESENTATION_MAP_SIZE.width}px`,
    });

    const timerId = window.setTimeout(() => {
      window.document.body.appendChild(container);
      void import('maplibre-gl').then((maplibregl) => {
        if (isCancelled) {
          return;
        }

        maplibregl.setWorkerUrl(mapLibreWorkerUrl);
        const map = new maplibregl.Map({
          attributionControl: false,
          canvasContextAttributes: { preserveDrawingBuffer: true },
          center: [...PROJECT_PRESENTATION_MAP_VIEW.defaultCenter],
          container,
          fadeDuration: 0,
          interactive: false,
          pixelRatio: 1,
          style: config.styleUrl,
          zoom: PROJECT_PRESENTATION_MAP_VIEW.defaultZoom,
        });
        const timeoutId = window.setTimeout(() => removeMap?.(), renderTimeoutMs);
        removeMap = () => {
          window.clearTimeout(timeoutId);
          map.remove();
          removeMap = null;
        };

        map.once('load', () => {
          localizeOpenMapTilesLabels(map);
          const [single] = coordinates;

          if (coordinates.length === 1 && single) {
            map.jumpTo({ center: single, zoom: PROJECT_PRESENTATION_MAP_VIEW.singlePointZoom });
          } else if (coordinates.length > 1) {
            const bounds = new maplibregl.LngLatBounds();
            coordinates.forEach((coordinate) => bounds.extend(coordinate));
            map.fitBounds(bounds, {
              animate: false,
              maxZoom: PROJECT_PRESENTATION_MAP_VIEW.maxZoom,
              padding: PROJECT_PRESENTATION_MAP_VIEW.padding,
            });
          }

          map.once('idle', () => {
            if (isCancelled) {
              return;
            }

            const value = {
              imageSrc: map.getCanvas().toDataURL('image/jpeg', 0.86),
              markers: coordinates.map((coordinate) => {
                const { x, y } = map.project(coordinate);
                return { x, y };
              }),
            };
            setSnapshot({ key: pointsKey, value });
            removeMap?.();
          });
          map.triggerRepaint();
        });
      }).catch(() => undefined);
    }, renderDelayMs);

    return () => {
      isCancelled = true;
      window.clearTimeout(timerId);
      removeMap?.();
      container.remove();
    };
  }, [pointsKey]);

  return snapshot?.key === pointsKey ? snapshot.value : null;
}
