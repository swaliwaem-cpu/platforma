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
  assert.match(
    chatSource,
    /handleGeoPickerConfirm[\s\S]*beginSubmission\(confirmedGeoSubmission\(pendingGeoSubmission\.content, geo\)\)/u,
  );
  assert.match(
    chatSource,
    /geoPickerTarget\?\.kind === 'ACTIVE_CONSTRAINT'[\s\S]*draft\.trim\(\)\.length > 0/u,
  );
  assert.match(
    chatSource,
    /handleGeoPickerCancel[\s\S]*setGeoPickerTarget\(null\)/u,
  );
  assert.match(chatSource, /openGeoPicker[\s\S]*setPendingGeoSubmission\(\{ content \}\)/u);
});

test('FIX-GEO2 UI submits raw text immediately and preserves explicit map context', () => {
  const submitSource = chatSource.match(/const handleSubmit =[\s\S]*?\n  \};/u)?.[0] ?? '';
  assert.match(
    submitSource,
    /beginSubmission\(\{ content, geo: activeGeo \? geoToBrowserInput\(activeGeo\) : null \}\)/u,
  );
  assert.doesNotMatch(submitSource, /resolveAssistantGeo|mapAssistantProductSubmission/u);
  assert.match(
    chatSource,
    /const replacement = withGeoSlotMetadata\([\s\S]*labelManualGeoConstraint\(geo, current\.label\)[\s\S]*current/u,
  );
  assert.match(chatSource, /constraint\.mode === 'NEAR'[\s\S]*editGeoPicker\(index\)/u);
  assert.doesNotMatch(chatSource, /AssistantGeoResolutionPanel|resolveAssistantGeo/u);
});

test('FIX-GEO2 removes the browser resolver error path without creating an unbound manual point', () => {
  assert.doesNotMatch(chatSource, /resolveAssistantGeo|AssistantGeoResolutionPanel/u);
  assert.match(chatSource, /setError\(readErrorMessage\(sendError\)\)/u);
  assert.match(chatSource, /setActiveGeo\(geo\)/u);
});

test('Assistant T05 browser keeps LocationIQ backend-only and preserves explicit manual-map entry', () => {
  assert.match(apiSource, /'\/assistant\/geo\/resolve'/u);
  assert.doesNotMatch(`${chatSource}\n${pickerSource}\n${apiSource}`, /LOCATIONIQ_API_KEY|locationiq\.com/iu);
  assert.match(chatSource, /aria-label="Выбрать точку на карте"/u);
  assert.match(chatSource, /PROPERTY_SEARCH_UNAVAILABLE|readErrorMessage/u);
});

test('Assistant FIX-GEO1 map renders reference plus search geometry and remains container-responsive', () => {
  assert.match(resultMapSource, /geometry: constraint\.searchArea, variant: 'SEARCH_AREA'/u);
  assert.match(resultMapSource, /geometry: constraint\.referenceGeometry, variant: 'REFERENCE'/u);
  assert.match(resultMapSource, /renderWithoutPoints/u);
  assert.match(resultMapSource, /constraint\.kind === 'POINT'/u);
  assert.match(resultMapSource, /variant: marker\.kind/u);
  assert.match(mapSource, /ResizeObserver/u);
  assert.match(mapSource, /ASSISTANT_GEO_FILL_LAYER_ID/u);
  assert.match(mapSource, /fitMapToContent/u);
  assert.match(styles, /\.map-price-marker--alternative/u);
  assert.match(styles, /\.assistant-geo-picker-map \.platform-map-shell/u);
});

test('Assistant FIX-GEO1 map fits stable geometry content without identity feedback loops', () => {
  assert.match(mapSource, /const emptyMapGeometries: MapGeometry\[\] = \[\]/u);
  assert.match(mapSource, /geometries = emptyMapGeometries/u);
  assert.match(mapSource, /\[geometryCoordinatesKey, status\]/u);
  assert.match(
    mapSource,
    /\[geometryCoordinatesKey, pointCoordinatesKey, prefersReducedMotion, status\]/u,
  );
  assert.doesNotMatch(mapSource, /\[geometries, geometryCoordinatesKey/u);
});

test('Assistant FIX-GEO1 uses trusted landmark ids, defaults and explicit line or area chips', () => {
  assert.match(chatSource, /referenceType: 'LANDMARK'/u);
  assert.match(chatSource, /до \$\{formatDistance\(geo\.distanceMeters\)\} от всей дороги/u);
  assert.match(chatSource, /внутри \$\{/u);
  assert.doesNotMatch(chatSource, /RADIUS_REQUIRED|Добавить радиус/u);
});

test('Assistant composite geo keeps separate constraint chips and renders every reference geometry', () => {
  assert.match(chatSource, /'operator' in geo/u);
  assert.match(chatSource, /constraints\.map/u);
  assert.match(chatSource, /operator: 'ALL'/u);
  assert.match(resultMapSource, /constraints\.flatMap/u);
  assert.match(resultMapSource, /assistant-reference-\$\{index\}/u);
  assert.match(resultMapSource, /assistant-search-area-\$\{index\}/u);
  assert.match(resultMapSource, /подходит под все географические условия/u);
  assert.match(resultMapSource, /по всем \$\{geo\.constraints\.length\} географическим условиям/u);
  assert.match(chatSource, /activeGeo \? geoConstraints\(activeGeo\)\.map/u);
  assert.match(chatSource, /labelManualGeoConstraint/u);
  assert.match(chatSource, /hasDuplicateGeoConstraints/u);
});

test('FIX-GEO2 keeps the composer free of pending browser-resolution state between conversations', () => {
  assert.match(
    chatSource,
    /const loadConversation[\s\S]*setPendingGeoSubmission\(null\)[\s\S]*setGeoPickerTarget\(null\)/u,
  );
  assert.match(
    chatSource,
    /disabled=\{isConversationLoading\}/u,
  );
  assert.match(
    chatSource,
    /const openGeoPicker = \(\) => \{[\s\S]*setPendingGeoSubmission\(\{ content \}\)/u,
  );
  assert.doesNotMatch(chatSource, /isResolvingGeo|geoResolution|pendingGeoSelections/u);
  assert.doesNotMatch(
    chatSource,
    /setConversation\(detail\.conversation\);[\s\S]{0,160}setActiveGeo\(null\)/u,
  );
});

test('Assistant T05 conversation restore respects a geo chip removed from the latest user message', () => {
  assert.match(
    chatSource,
    /find\(\(message\) => message\.role === 'USER'\)\?\.geo \?\? null/u,
  );
});
