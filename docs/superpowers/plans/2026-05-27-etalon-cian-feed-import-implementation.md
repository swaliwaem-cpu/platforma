# Etalon CIAN Feed Import Implementation Plan

## Goal

Extend the existing `CIAN_XML` importer so the Etalon feed is parsed as unified Platforma feed data:

- missing `Booking.Status` means `AVAILABLE`;
- `JKSchema.Name` is the project/object group;
- `JKSchema.House.Name` is the lot building/corpus;
- `FlatRoomsCount=9` means studio (`rooms=0`);
- layout photos and regular photos are both imported;
- source analysis shows project names and produces mapping filters for CIAN projects.

## Steps

1. Add failing tests for Etalon-style CIAN XML.
   - Parser should normalize missing booking status without warnings.
   - Parser should read project, building, section, flat number, rooms and media from Etalon fields.
   - Source analysis should group CIAN units by project name and produce `projectNames` filters.

2. Add UI/shared contract checks.
   - Shared `FeedSourceAnalysisObject` should expose `projectNames` and `externalIds`.
   - Admin analysis meta should include `projectNames`.
   - Analysis summary label should be Russian (`Предупреждения`).

3. Update `tools/feed-import/src/index.ts`.
   - Add `projectName` to normalized units.
   - Extend CIAN fallbacks for `Developer`, `JKSchema`, `FlatRoomsCount`, `FlatNumber`, `SectionNumber`, and `title`.
   - Keep explicit unknown statuses as warnings, but default empty CIAN statuses to `AVAILABLE`.
   - Add generic source filters with `projectNames` while preserving Yandex filters.

4. Update web/shared files.
   - Extend shared analysis object type.
   - Include `projectNames` and `externalIds` in admin mapping keys/meta.
   - Keep existing Yandex mapping behavior intact.

5. Verify.
   - `pnpm --filter @platforma/feed-import test`
   - `pnpm --filter @platforma/web test`
   - `pnpm --filter @platforma/api test`
   - `pnpm test`
   - `pnpm build`
   - Run live feed analyze read-only against the Etalon URL.
