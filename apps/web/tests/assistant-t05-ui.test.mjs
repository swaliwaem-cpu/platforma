import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [chatSource, pickerSource, resultMapSource, mapSource, styles, apiSource] = await Promise.all([
  readFile(new URL('../src/assistant/AssistantChat.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/assistant/AssistantGeoPicker.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/assistant/AssistantGeoResultMap.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/map/MapLibreMap.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/assistant/assistant.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/assistant/assistantApi.ts', import.meta.url), 'utf8'),
]);

test('Assistant T05 picker keeps map movement as draft and searches only from explicit confirmation', () => {
  assert.match(pickerSource, /onViewportChange=\{handleViewportChange\}/u);
  assert.match(pickerSource, /data-assistant-geo-confirm/u);
  assert.match(pickerSource, /onConfirm\(\{[\s\S]*source: 'MANUAL'/u);
  assert.doesNotMatch(pickerSource, /sendAssistantMessage|resolveAssistantGeo/u);
  assert.match(chatSource, /handleGeoPickerConfirm[\s\S]*beginSubmission\(pendingGeoSubmission\.content, geo\)/u);
  assert.match(chatSource, /handleGeoPickerCancel[\s\S]*geoPickerPurpose === 'EDIT'/u);
  assert.match(chatSource, /openGeoPicker[\s\S]*setPendingGeoSubmission\(\{ content \}\)/u);
});

test('Assistant T05 browser keeps LocationIQ backend-only and exposes explicit degraded actions', () => {
  assert.match(apiSource, /'\/assistant\/geo\/resolve'/u);
  assert.doesNotMatch(`${chatSource}\n${pickerSource}\n${apiSource}`, /LOCATIONIQ_API_KEY|locationiq\.com/iu);
  assert.match(chatSource, /Указать на карте/u);
  assert.match(chatSource, /Уточнить название/u);
  assert.match(chatSource, /PROPERTY_SEARCH_UNAVAILABLE|readErrorMessage/u);
});

test('Assistant FIX-GEO1 map renders reference plus search geometry and remains container-responsive', () => {
  assert.match(resultMapSource, /geometry: geo\.searchArea, variant: 'SEARCH_AREA'/u);
  assert.match(resultMapSource, /geometry: geo\.referenceGeometry, variant: 'REFERENCE'/u);
  assert.match(resultMapSource, /renderWithoutPoints/u);
  assert.match(resultMapSource, /geo\.kind === 'POINT'/u);
  assert.match(resultMapSource, /variant: marker\.kind/u);
  assert.match(mapSource, /ResizeObserver/u);
  assert.match(mapSource, /ASSISTANT_GEO_FILL_LAYER_ID/u);
  assert.match(mapSource, /fitMapToContent/u);
  assert.match(styles, /\.map-price-marker--alternative/u);
  assert.match(styles, /\.assistant-geo-picker-map \.platform-map-shell/u);
});

test('Assistant FIX-GEO1 uses trusted landmark ids, defaults and explicit line or area chips', () => {
  assert.match(chatSource, /referenceType: 'LANDMARK'/u);
  assert.match(chatSource, /до \$\{formatDistance\(geo\.distanceMeters\)\} от всей дороги/u);
  assert.match(chatSource, /внутри \$\{/u);
  assert.doesNotMatch(chatSource, /RADIUS_REQUIRED|Добавить радиус/u);
});

test('Assistant T05 conversation restore respects a geo chip removed from the latest user message', () => {
  assert.match(
    chatSource,
    /find\(\(message\) => message\.role === 'USER'\)\?\.geo \?\? null/u,
  );
});
