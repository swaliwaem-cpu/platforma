import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(currentDir, '../src/App.tsx'), 'utf8');
const objectDetailSource = readFileSync(resolve(currentDir, '../src/objects/ObjectDetailPage.tsx'), 'utf8');
const styles = readFileSync(resolve(currentDir, '../src/styles.css'), 'utf8');

test('app routes object lot URLs to lot detail page', () => {
  assert.match(appSource, /import \{ ObjectDetailPage, ObjectLotDetailPage \} from '\.\/objects\/ObjectDetailPage';/);
  assert.match(appSource, /const objectLotRoute = parseObjectLotRoute\(pathname\);/);
  assert.match(appSource, /function parseObjectLotRoute\(pathname: string\)/);
  assert.match(appSource, /\^\\\/objects\\\/\(\[\^\/\]\+\)\\\/lots\\\/\(\[\^\/\]\+\)\\\/\?\$/);
  assert.match(appSource, /<ObjectLotDetailPage[\s\S]*?slug=\{objectLotRoute\.slug\}[\s\S]*?unitId=\{objectLotRoute\.unitId\}/);
  assert.match(appSource, /onBack=\{\(\) => navigate\(`\/objects\/\$\{encodeURIComponent\(objectLotRoute\.slug\)\}`\)\}/);
});

test('lot detail page loads object and one feed unit', () => {
  assert.match(objectDetailSource, /FeedUnitResponse/);
  assert.match(objectDetailSource, /export function ObjectLotDetailPage/);
  assert.match(objectDetailSource, /apiRequest<ObjectResponse>\(`\/objects\/slug\/\$\{encodeURIComponent\(slug\)\}`/);
  assert.match(
    objectDetailSource,
    /apiRequest<FeedUnitResponse>\([\s\S]*?`\/objects\/\$\{objectData\.object\.id\}\/feed-units\/\$\{encodeURIComponent\(unitId\)\}`/,
  );
  assert.match(objectDetailSource, /setObject\(objectData\.object\);/);
  assert.match(objectDetailSource, /setUnit\(unitData\.unit\);/);
});

test('lot detail page renders media carousel and required fact cards', () => {
  assert.match(objectDetailSource, /className="object-detail-page object-lot-page"/);
  assert.match(objectDetailSource, /function ObjectLotMediaCarousel/);
  assert.match(objectDetailSource, /className="object-lot-media-carousel"/);
  assert.match(objectDetailSource, /className="object-lot-media-stage"/);
  assert.match(objectDetailSource, /className="object-lot-media-image"/);
  assert.match(objectDetailSource, /function getObjectLotFactRows\(unit: FeedUnit\)/);
  assert.match(objectDetailSource, /formatComputedFeedUnitPricePerMeter\(unit\)/);
  assert.match(objectDetailSource, /label: 'Цена'/);
  assert.match(objectDetailSource, /label: 'Цена за м²'/);
  assert.match(objectDetailSource, /label: 'Площадь'/);
  assert.match(objectDetailSource, /label: 'Тип лота'/);
  assert.match(objectDetailSource, /label: 'Этаж'/);
  assert.match(objectDetailSource, /label: 'Корпус\/секция'/);
  assert.match(objectDetailSource, /label: 'Адрес'/);
  assert.match(objectDetailSource, /label: 'Статус'/);
  assert.match(styles, /\.object-lot-page\s*\{/);
  assert.match(styles, /\.object-lot-media-carousel\s*\{/);
  assert.match(styles, /\.object-lot-facts\s*\{/);
});
