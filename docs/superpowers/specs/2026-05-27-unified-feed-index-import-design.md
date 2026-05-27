# Unified Feed Index Import Design

## Goal

Make feed setup work as a unified importer flow:

1. The user provides a feed URL or uploads an XML file.
2. The system detects whether the input is a single XML feed or an HTML/XML index page.
3. For index pages, the system discovers available marketplace feeds and lets the user choose exactly one platform.
4. The system auto-detects the developer and residential projects from the selected feed data.
5. The user confirms or corrects all matches with dropdowns before saving.

The saved source must be a live bridge. For index pages, every `Preview` and `Run` re-reads the index and imports the currently discovered XML files for the selected platform.

## Decisions

- Auto-create developers or real estate objects: **no**.
- Match only existing developers and existing ЖК objects.
- Index page persistence model: **one live index source**.
- Platform selection for an index source: **exactly one platform**.
- Unmatched or low-confidence projects: default to **exclude from import**.
- Manual correction remains available through developer and ЖК dropdowns.
- For `INDEX_URL`, store the chosen platform in existing `format`.

## Scope

In scope:

- support `INDEX_URL` sources beside existing `URL` and `FILE` sources;
- auto-detect feed format for single XML URL/file analysis;
- discover XML links from index pages;
- group discovered XML files by supported platform;
- analyze all XML files for the selected platform as one source;
- auto-suggest an existing developer;
- auto-suggest existing ЖК mappings after a developer is selected;
- preserve manual corrections in saved mappings;
- import index sources through the existing feed import engine;
- add tests for discovery, detection, API contracts, UI behavior, and index imports.

Out of scope:

- no auto-creation of new developers or ЖК;
- no multi-platform source in one saved feed source;
- no scheduled/background sync changes;
- no new third-party dependencies;
- no production deployment as part of this design;
- no crawler behavior beyond direct XML links discovered from the provided index page.

## Source Model

Extend `FeedSourceKind`:

- `URL`: one XML URL, existing behavior.
- `FILE`: one uploaded XML file, existing behavior.
- `INDEX_URL`: one index page URL containing links to multiple XML feeds.

For `INDEX_URL`:

- `url` stores the index page URL;
- `format` stores the chosen platform format: `YANDEX_REALTY`, `CIAN_XML`, or `AVITO_XML`;
- `filterJson`, `developerId`, `objectId`, and `mappings` keep their current meaning;
- when mappings exist, `objectId` remains empty/null and each parsed project routes through mappings.

No extra platform field is needed in the first version.

## Input Detection

The analyze flow accepts a local UI value `AUTO` for format detection. Saved sources still persist a concrete `FeedFormat`.

Detection rules:

- XML root `<realty-feed>` means `YANDEX_REALTY`.
- XML root `<feed>` with CIAN-compatible objects means `CIAN_XML`.
- XML root `<Ads>` means `AVITO_XML`.
- HTML containing XML links means index discovery.
- Unknown XML or an HTML page without XML links returns a clear validation error.

The XML root is authoritative. File names such as `YandexRealty`, `Cian`, or `Avito` are only secondary hints for labels and diagnostics.

## Index Discovery

For an index URL:

1. Download the index page.
2. Extract links ending in `.xml`, including URL-encoded names.
3. Resolve relative links against the index URL.
4. Deduplicate links.
5. Keep links on the same origin by default.
6. Download discovered XML files and detect their format.
7. Build platform candidates.

Each `FeedIndexPlatformCandidate` should include:

- `format`;
- label;
- XML file count;
- parsed units count;
- warnings count;
- failed XML count;
- discovered file summaries with URL, detected format, units count, and errors.

The UI shows these candidates and requires selecting one platform before project mapping.

## Analysis Flow

For a single XML URL or file:

- detect the format if UI format is `AUTO`;
- parse the XML with the matching parser;
- return `FeedSourceAnalysis`;
- auto-suggest developer and ЖК mappings.

For an index URL:

- first analyze call with `AUTO` returns discovery only;
- user selects exactly one platform;
- second analyze call passes `sourceKind=INDEX_URL` and selected `format`;
- the analyzer fetches and parses all XML files from the index that match that format;
- parsed units and warnings are merged into one `FeedSourceAnalysis`.

The existing analysis grouping rules remain:

- Yandex: prefer `yandex-building-id`, `yandex-house-id`, `building-name`, and address.
- CIAN: prefer `JKSchema.Name`.
- Avito: prefer `NewDevelopmentId`.
- Fallback: address and external ids.

## External Ids In Index Sources

The database uniqueness is `sourceId + externalId`. In an index source, one source can combine many XML files, so raw external ids may collide between files.

To prevent cross-file overwrites:

- for `INDEX_URL`, normalize persisted `externalId` as a source-scoped id that includes a stable XML file key and the raw feed id;
- keep the raw feed id and XML URL in `rawPayload` for debugging;
- analysis filters continue using project/building/development fields instead of these namespaced ids whenever possible.

This avoids accidental updates when two projects use the same raw id, while still letting disappeared lots archive through the existing source-level logic.

## Developer Matching

The feed import CLI returns raw analysis data. The API enriches the response with suggestions because it has access to existing developers and objects.

Developer matching uses normalized names from:

- `analysis.developerName`;
- sales agent organization/name;
- CIAN developer fields;
- Avito company/developer fields;
- index URL or file names as weak hints.

Normalization removes noise:

- case;
- `ё` vs `е`;
- quotes;
- legal prefixes like `ООО`, `АО`, `ПАО`;
- group markers like `ГК`;
- duplicate spaces and punctuation.

If one existing developer has a high-confidence match, the UI preselects it. If confidence is low or ambiguous, the developer select stays empty and the user must choose manually.

## ЖК Matching

Object suggestions are calculated only among existing objects for the selected developer.

Matching signals:

- exact normalized title match;
- normalized slug/title match;
- unique strong partial match;
- known feed project names from analysis;
- address is a weak secondary hint;
- technical feed ids are stored in filters but do not create a match by themselves.

For each analysis object:

- high-confidence unique match is preselected;
- low-confidence or ambiguous match defaults to `Исключить из загрузки`;
- the user can choose any existing ЖК for the selected developer in the dropdown;
- changing developer clears or recalculates object selections that no longer belong to that developer.

## Admin UI

The feeds admin source form becomes a guided flow inside the existing screen:

1. **Источник**
   - Source kind: `URL`, `Индекс XML`, `XML-файл`.
   - URL/file input.
   - Format defaults to `Авто`; manual format remains as an override.

2. **Разбор**
   - Button `Разобрать`.
   - For single XML, show normal analysis immediately.
   - For index, show platform candidates first.

3. **Площадка**
   - Cards or rows for detected platforms.
   - User can select exactly one platform.
   - After selection, run analysis for that platform.

4. **Застройщик**
   - Existing developer dropdown.
   - Auto-suggestion can preselect one developer.
   - User can override.

5. **ЖК**
   - Existing analysis/mapping list remains the main control.
   - Each feed project row has a ЖК dropdown filtered by selected developer.
   - Default is `Исключить из загрузки` for unmatched rows.
   - Saving sends only mappings with selected object ids.

6. **Сохранение**
   - `INDEX_URL` source persists the index URL, selected `format`, selected developer, and confirmed mappings.
   - Single XML URL/file persists the detected or manually selected concrete `format`.

No new UI library is needed.

## Import And Preview Behavior

For `URL` and `FILE`, behavior remains unchanged.

For `INDEX_URL`, `Preview` and `Run`:

1. Download the index URL.
2. Discover XML links.
3. Detect formats.
4. Keep only XML files matching `source.format`.
5. Parse and merge units.
6. Apply saved source mappings.
7. Plan creates/updates/archives exactly like existing imports.
8. Run persists units, details, media, and object aggregates through the existing engine.

If the index temporarily has broken XML files:

- successful files can still be analyzed/imported;
- failed files produce warnings/errors in the run report;
- a complete index download failure fails the run;
- a selected platform with no discovered XML files fails validation before import.

## API And Shared Contracts

Extend shared contracts:

- `FeedSourceKind = 'URL' | 'FILE' | 'INDEX_URL'`;
- `FeedIndexDiscovery`;
- `FeedIndexPlatformCandidate`;
- `FeedIndexFileCandidate`;
- optional developer suggestion;
- optional object suggestions per analysis object.

The analyze response should support both states:

- discovery-only response for index platform selection;
- full analysis response for a single XML or selected index platform.

One practical shape:

```ts
type FeedSourceAnalysisResponse = {
  discovery: FeedIndexDiscovery | null;
  analysis: FeedSourceAnalysis | null;
};
```

Existing callers should handle `analysis === null` only for index discovery.

## Database Migration

Add a Prisma/Postgres enum value:

- `FeedSourceKind.INDEX_URL @map("index_url")`.

No new table is required for the first version.

## Testing

Feed import tests:

- detect Yandex Realty, CIAN XML, and Avito XML by root structure;
- discover XML links from an HTML index;
- group index files by platform;
- analyze selected platform files together;
- namespace external ids for index imports to avoid cross-file collisions;
- import `INDEX_URL` with mixed Yandex/CIAN/Avito index and selected `CIAN_XML`;
- archive disappeared lots on a later `INDEX_URL` run through existing logic.

API tests:

- shared contracts expose `INDEX_URL` and discovery types;
- Prisma schema/migration adds `index_url`;
- `POST /feeds/analyze` can return discovery without analysis;
- selected platform analysis returns `analysis`;
- create/update source accepts `INDEX_URL` with URL and concrete format;
- `INDEX_URL` rejects missing URL or `AUTO` as persisted format.

Web tests:

- source kind UI includes `Индекс XML`;
- format selector includes `Авто` for analysis but saves concrete formats;
- index discovery renders platform candidates;
- selecting one platform triggers platform analysis;
- developer suggestion can preselect a developer;
- unmatched ЖК rows default to `Исключить из загрузки`;
- manual developer change clears invalid ЖК selections.

Manual QA:

- Analyze `https://feeds.sminex.com/xml/`.
- Select only `Yandex Realty`, confirm files/lots are scoped to Yandex.
- Confirm Sminex is suggested only if an existing developer matches.
- Confirm projects can be mapped only to existing ЖК for the selected developer.
- Save as `INDEX_URL`, run `Preview`, then run `Run`.
- Re-run after removing one XML or mocking a changed index and confirm disappeared units archive.

