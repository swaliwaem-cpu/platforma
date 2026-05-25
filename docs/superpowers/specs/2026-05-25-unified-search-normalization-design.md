# Unified Search Normalization Design

## Goal

Unify search behavior across Platforma so Russian names can be found through Latin transliteration and through text typed in the wrong keyboard layout.

## Scope

Apply the behavior everywhere the project currently exposes free-text search:

- catalog and map object search through `/objects` and `/map/objects`;
- directory search for developers, locations, and metro stations;
- admin object list search;
- admin user list search;
- object detail lot search through `/objects/:id/feed-units`;
- feed unit search through `/feeds/units`;
- frontend quick edit search for developer and metro selectors.

No new dependencies, migrations, schema changes, or UI layout changes are required.

## Behavior

For every search term, build a small unique set of normalized variants:

- normalized original input;
- input converted from a wrong English layout to Russian, for example `Ifufk` -> `шагал`;
- input converted from a wrong Russian layout to English, for example `Ырфпфд` -> `shagal`;
- Latin transliteration to Russian, for example `Shagal` -> `шагал`;
- Russian transliteration to Latin, for slug and Latin fields.

Search matches when any normalized field contains any search variant. Existing dot-insensitive and whitespace-normalizing behavior remains.

## Architecture

Create shared search helpers in `packages/shared` so API and web quick edit use the same normalization tables and variant generation.

API services use helper-generated variants to build Prisma `contains` OR filters. The catalog/map raw SQL search uses the same variants as LIKE patterns.

Frontend quick edit uses the same helper for local filtering without changing the UI.

## Testing

Backend tests verify that search variants are generated and passed into catalog/map raw SQL, Prisma directory filters, user filters, object feed-unit filters, and feed unit filters.

Frontend tests verify that quick edit matches `Shagal` and `Ifufk` against `Шагал`.

Manual QA should check representative searches in catalog, map, admin object list, users, directories, lots, and quick edit selectors.
