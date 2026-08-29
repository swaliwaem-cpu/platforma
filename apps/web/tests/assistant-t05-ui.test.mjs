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
    /geoPickerTarget\?\.kind !== 'PENDING_SLOT'[\s\S]*geoPickerTarget\?\.kind === 'ACTIVE_CONSTRAINT'[\s\S]*draft\.trim\(\)\.length > 0/u,
  );
  assert.match(
    chatSource,
    /handleGeoPickerCancel[\s\S]*setGeoPickerTarget\(null\)/u,
  );
  assert.match(chatSource, /openGeoPicker[\s\S]*setPendingGeoSubmission\(\{ content \}\)/u);
});

test('ZAEBAL1 UI sends the shared prepared body and preserves composite slot metadata', () => {
  assert.match(chatSource, /mapAssistantProductSubmission\([\s\S]*beginSubmission\(productDecision\.body\)/u);
  assert.match(
    chatSource,
    /const replacement = withGeoSlotMetadata\([\s\S]*labelManualGeoConstraint\(geo, current\.label\)[\s\S]*current/u,
  );
  assert.match(chatSource, /constraint\.mode === 'NEAR'[\s\S]*editGeoPicker\(index\)/u);
  assert.match(chatSource, /allowsManualPoint = resolution\.mode === 'NEAR'/u);
});

test('ZAEBAL1 generic resolver errors stay fail closed without an unbound manual point', () => {
  assert.match(chatSource, /Не удалось проверить географическое условие/u);
  assert.doesNotMatch(
    chatSource,
    /assistant-geo-resolution--error[\s\S]{0,500}openGeoPicker/u,
  );
});

test('Assistant T05 browser keeps LocationIQ backend-only and exposes explicit degraded actions', () => {
  assert.match(apiSource, /'\/assistant\/geo\/resolve'/u);
  assert.doesNotMatch(`${chatSource}\n${pickerSource}\n${apiSource}`, /LOCATIONIQ_API_KEY|locationiq\.com/iu);
  assert.match(chatSource, /Указать на карте/u);
  assert.match(chatSource, /Уточнить название/u);
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
  assert.match(styles, /\.assistant-geo-constraint-list[\s\S]*max-height:[\s\S]*overflow-y: auto/u);
  assert.match(chatSource, /Все выбранные условия применяются одновременно/u);
  assert.match(chatSource, /labelManualGeoConstraint/u);
  assert.match(chatSource, /hasDuplicateGeoConstraints/u);
});

test('Assistant composite geo isolates pending resolution state between conversations', () => {
  assert.match(
    chatSource,
    /const loadConversation[\s\S]*setIsResolvingGeo\(false\)[\s\S]*setGeoResolution\(null\)[\s\S]*setPendingGeoSubmission\(null\)[\s\S]*setPendingGeoSelections\(\{\}\)/u,
  );
  assert.match(
    chatSource,
    /disabled=\{isConversationLoading \|\| isResolvingGeo \|\| geoResolution !== null \|\| geoError !== null\}/u,
  );
  assert.match(
    chatSource,
    /if \(!slotId\) \{[\s\S]*setPendingGeoSubmission\(\{ content \}\)/u,
  );
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
