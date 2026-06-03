# Lot Card Split Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перестроить страницу лота в двухколоночную карточку: галерея слева, паспорт характеристик справа, с корректным показом скидочной цены только при реальной скидке.

**Architecture:** Изменение остается внутри существующего `ObjectLotDetailPage` и CSS для object detail. Данные не меняются: добавляется view-helper для определения реальной скидки и разметка `object-lot-split-card` вокруг существующего carousel и fact rows.

**Tech Stack:** React, TypeScript, Vite, CSS, Node test runner, pnpm workspace.

---

### Task 1: Lot Detail Regression Tests

**Files:**
- Modify: `apps/web/tests/object-lot-detail-page.test.mjs`

- [ ] Add RED assertions for `object-lot-split-card`, `object-lot-media-panel`, `object-lot-info-panel`, `object-lot-price-summary`, `object-lot-fact-row`, `object-lot-fact-line`.
- [ ] Add RED assertions for helper `hasFeedUnitRealDiscount(unit: FeedUnit)` and conditional label rendering: `hasFeedUnitRealDiscount(unit) ? 'Цена со скидкой' : 'Цена'`.
- [ ] Add RED CSS assertions for two equal columns and mobile stacking.
- [ ] Run `pnpm --filter @platforma/web test -- object-lot-detail-page.test.mjs` and confirm the new assertions fail.

### Task 2: Lot Detail Markup And Pricing Logic

**Files:**
- Modify: `apps/web/src/objects/ObjectDetailPage.tsx`

- [ ] Add `hasFeedUnitRealDiscount(unit: FeedUnit)` that parses `unit.price` and `unit.discountPrice` as numbers and returns true only when both are valid positive prices and `discountPrice < price`.
- [ ] Add `getObjectLotPriceSummary(unit: FeedUnit)` returning label, primary price, and optional secondary price.
- [ ] Replace the vertical carousel + summary sections with `object-lot-split-card`.
- [ ] Render fact rows as `object-lot-fact-row` with `dt`, dotted `span`, and `dd`.

### Task 3: Split Layout CSS

**Files:**
- Modify: `apps/web/src/styles.css`

- [ ] Add two equal columns for `.object-lot-split-card`.
- [ ] Make the left media panel and right info panel share a single card surface.
- [ ] Style the right column as a quiet passport list with dotted leaders.
- [ ] Stack columns on narrow screens and keep text from overflowing.

### Task 4: Verification And Project Log

**Files:**
- Modify: `docs/CODEX_LOG.md`

- [ ] Run `pnpm --filter @platforma/web test -- object-lot-detail-page.test.mjs`.
- [ ] Run `pnpm --filter @platforma/web build`.
- [ ] Append a concise entry to `docs/CODEX_LOG.md`.
- [ ] Report changed files, checks, manual QA, and any risks.
