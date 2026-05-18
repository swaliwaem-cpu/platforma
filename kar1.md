# Object Carousel Lightbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Доработать карусель объекта: миниатюры показываются по наведению на нижнюю зону, лента миниатюр центрируется, клик по большому фото открывает полноразмерное изображение в модалке без обрезки.

**Architecture:** Изменение локальное для страницы объекта. `ObjectImageCarousel` управляет активным кадром и состоянием lightbox-модалки, `SecureImage` остается единственным способом загрузки защищенных изображений. CSS управляет hover/focus-поведением миниатюр, центрированием ленты и отображением модалки через `object-fit: contain`.

**Tech Stack:** Vite, React 19, TypeScript, CSS, Node test runner, существующий `SecureImage`.

---

## Files

- Modify: `apps/web/src/objects/ObjectDetailPage.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/tests/object-detail-styles.test.mjs`
- Create: `apps/web/tests/object-detail-carousel.test.mjs`
- Do not modify: backend/API, shared contracts, dependencies, lockfile, `.playwright-mcp/console-2026-05-14T13-54-22-429Z.log`

---

### Task 1: Add Static Tests For Carousel Contract

**Files:**
- Modify: `apps/web/tests/object-detail-styles.test.mjs`
- Create: `apps/web/tests/object-detail-carousel.test.mjs`

- [x] **Step 1: Add style assertions to `apps/web/tests/object-detail-styles.test.mjs`**

Append these tests after the existing carousel style test:

```js
test('object detail carousel hides thumbnails until lower hover or focus zone', () => {
  assert.match(
    styles,
    /\.carousel-thumbnail-zone\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*0;[\s\S]*?left:\s*0;[\s\S]*?right:\s*0;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.carousel-thumbnails\s*\{[\s\S]*?left:\s*50%;[\s\S]*?width:\s*min\(calc\(100% - 28px\),\s*1240px\);[\s\S]*?justify-content:\s*center;[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;[\s\S]*?transform:\s*translate\(-50%,\s*8px\);[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.carousel-thumbnail-zone:hover \.carousel-thumbnails,\s*\.carousel-thumbnail-zone:focus-within \.carousel-thumbnails\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;[\s\S]*?transform:\s*translate\(-50%,\s*0\);[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /@media\s*\(hover:\s*none\)\s*\{[\s\S]*?\.carousel-thumbnails\s*\{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;[\s\S]*?\}/,
  );
});

test('object detail carousel modal keeps original image contained', () => {
  assert.match(
    styles,
    /\.carousel-modal-backdrop\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;[\s\S]*?z-index:\s*90;[\s\S]*?\}/,
  );

  assert.match(
    styles,
    /\.carousel-modal-image img\s*\{[\s\S]*?max-width:\s*calc\(100vw - 48px\);[\s\S]*?max-height:\s*calc\(100dvh - 112px\);[\s\S]*?object-fit:\s*contain;[\s\S]*?object-position:\s*center center;[\s\S]*?\}/,
  );
});
```

- [x] **Step 2: Create `apps/web/tests/object-detail-carousel.test.mjs`**

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const currentDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(currentDir, '../src/objects/ObjectDetailPage.tsx'), 'utf8');

test('object detail carousel opens a dialog lightbox from the main image', () => {
  assert.match(source, /const \[lightboxIndex,\s*setLightboxIndex\] = useState<number \| null>\(null\);/);
  assert.match(source, /function openLightbox\(\)\s*\{[\s\S]*?setLightboxIndex\(activeIndex\);[\s\S]*?\}/);
  assert.match(source, /className="object-carousel-media-button"[\s\S]*?onClick=\{openLightbox\}/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
});

test('object detail carousel lightbox uses original image variant and keyboard close', () => {
  assert.match(source, /variant="original"/);
  assert.match(source, /function closeLightbox\(\)\s*\{[\s\S]*?setLightboxIndex\(null\);[\s\S]*?\}/);
  assert.match(source, /event\.key === 'Escape'/);
  assert.match(source, /className="carousel-modal-backdrop"/);
  assert.match(source, /className="carousel-modal-image"/);
});
```

- [x] **Step 3: Run web tests and verify the new tests fail before implementation**

Run:

```bash
pnpm --filter @platforma/web test
```

Expected: FAIL. The new tests should fail because `lightboxIndex`, `.carousel-thumbnail-zone`, and `.carousel-modal-*` do not exist yet.

---

### Task 2: Add Lightbox State And Main Image Button

**Files:**
- Modify: `apps/web/src/objects/ObjectDetailPage.tsx`

- [x] **Step 1: Add lightbox state inside `ObjectImageCarousel`**

Add this state next to `activeIndex`:

```tsx
const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
const lightboxImage = lightboxIndex === null ? null : images[lightboxIndex] ?? null;
```

- [x] **Step 2: Reset invalid lightbox index when images change**

Extend the existing bounds effect:

```tsx
useEffect(() => {
  if (activeIndex > Math.max(images.length - 1, 0)) {
    setActiveIndex(0);
  }

  if (lightboxIndex !== null && lightboxIndex > Math.max(images.length - 1, 0)) {
    setLightboxIndex(null);
  }
}, [activeIndex, images.length, lightboxIndex]);
```

- [x] **Step 3: Add carousel and lightbox handlers**

Place these functions after `showNextImage`:

```tsx
function openLightbox() {
  setLightboxIndex(activeIndex);
}

function closeLightbox() {
  setLightboxIndex(null);
}

function showPreviousLightboxImage() {
  setLightboxIndex((currentIndex) => {
    if (currentIndex === null) {
      return currentIndex;
    }

    return currentIndex === 0 ? images.length - 1 : currentIndex - 1;
  });
}

function showNextLightboxImage() {
  setLightboxIndex((currentIndex) => {
    if (currentIndex === null) {
      return currentIndex;
    }

    return (currentIndex + 1) % images.length;
  });
}
```

- [x] **Step 4: Add Escape key close while the lightbox is open**

Add this effect before the empty-state return:

```tsx
useEffect(() => {
  if (lightboxIndex === null) {
    return;
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      closeLightbox();
    }
  }

  window.addEventListener('keydown', handleKeyDown);

  return () => window.removeEventListener('keydown', handleKeyDown);
}, [lightboxIndex]);
```

- [x] **Step 5: Wrap the main `SecureImage` in a button**

Replace the direct `SecureImage` inside `.object-carousel-media` with:

```tsx
<button
  aria-label="Открыть фото в полном размере"
  className="object-carousel-media-button"
  type="button"
  onClick={openLightbox}
>
  <SecureImage accessToken={accessToken} alt={activeImage.alt ?? objectTitle} fileId={activeImage.file.id} variant="detail" />
</button>
```

- [x] **Step 6: Run tests and verify style tests still fail**

Run:

```bash
pnpm --filter @platforma/web test
```

Expected: FAIL. Component source assertions should be closer to passing, while style assertions still fail until CSS and modal markup are added.

---

### Task 3: Add Modal Markup With Original Image Variant

**Files:**
- Modify: `apps/web/src/objects/ObjectDetailPage.tsx`

- [x] **Step 1: Render the modal after the thumbnail block**

Add this block before the closing `</section>` of `ObjectImageCarousel`:

```tsx
{lightboxImage ? (
  <div className="carousel-modal-backdrop" onClick={closeLightbox}>
    <section
      aria-label="Полноразмерное фото объекта"
      aria-modal="true"
      className="carousel-modal"
      role="dialog"
      onClick={(event) => event.stopPropagation()}
    >
      <button
        aria-label="Закрыть полноразмерное фото"
        className="carousel-modal-close"
        type="button"
        onClick={closeLightbox}
      >
        ×
      </button>

      {hasManyImages ? (
        <button
          aria-label="Предыдущее полноразмерное фото"
          className="carousel-modal-button carousel-modal-button--previous"
          type="button"
          onClick={showPreviousLightboxImage}
        >
          ‹
        </button>
      ) : null}

      <div className="carousel-modal-image">
        <SecureImage
          accessToken={accessToken}
          alt={lightboxImage.alt ?? objectTitle}
          fileId={lightboxImage.file.id}
          variant="original"
        />
      </div>

      {hasManyImages ? (
        <>
          <button
            aria-label="Следующее полноразмерное фото"
            className="carousel-modal-button carousel-modal-button--next"
            type="button"
            onClick={showNextLightboxImage}
          >
            ›
          </button>
          <span className="carousel-modal-counter">
            {(lightboxIndex ?? 0) + 1} / {images.length}
          </span>
        </>
      ) : null}
    </section>
  </div>
) : null}
```

- [x] **Step 2: Run component source tests and verify only style gaps remain**

Run:

```bash
pnpm --filter @platforma/web test
```

Expected: FAIL only on CSS selectors if component markup matches the assertions.

---

### Task 4: Rework Thumbnail Hover Zone And Centering

**Files:**
- Modify: `apps/web/src/objects/ObjectDetailPage.tsx`
- Modify: `apps/web/src/styles.css`

- [x] **Step 1: Wrap thumbnails in a lower hover zone**

Replace the current thumbnail block:

```tsx
<div className="carousel-thumbnails" aria-label="Миниатюры галереи">
  {images.map((image, index) => (
    <button
      key={image.id}
      aria-label={`Фото ${index + 1}`}
      className={index === activeIndex ? 'carousel-thumbnail carousel-thumbnail--active' : 'carousel-thumbnail'}
      type="button"
      onClick={() => setActiveIndex(index)}
    >
      <SecureImage
        accessToken={accessToken}
        alt={image.alt ?? `${objectTitle}, миниатюра ${index + 1}`}
        fileId={image.file.id}
        variant="thumbnail"
      />
    </button>
  ))}
</div>
```

with:

```tsx
<div className="carousel-thumbnail-zone">
  <div className="carousel-thumbnails" aria-label="Миниатюры галереи">
    {images.map((image, index) => (
      <button
        key={image.id}
        aria-label={`Фото ${index + 1}`}
        className={index === activeIndex ? 'carousel-thumbnail carousel-thumbnail--active' : 'carousel-thumbnail'}
        type="button"
        onClick={() => setActiveIndex(index)}
      >
        <SecureImage
          accessToken={accessToken}
          alt={image.alt ?? `${objectTitle}, миниатюра ${index + 1}`}
          fileId={image.file.id}
          variant="thumbnail"
        />
      </button>
    ))}
  </div>
</div>
```

- [x] **Step 2: Add styles for the main image button**

Add near `.object-carousel-media` styles:

```css
.object-carousel-media-button {
  display: grid;
  width: 100%;
  height: 100%;
  overflow: hidden;
  place-items: center;
  border: 0;
  background: transparent;
  padding: 0;
}

.object-carousel-media-button:focus-visible {
  outline: 3px solid rgb(37 99 235 / 72%);
  outline-offset: -6px;
}
```

- [x] **Step 3: Update image centering styles**

Update the existing image rule to include the button and center positioning:

```css
.object-carousel-media-button img,
.object-carousel-media img,
.object-gallery-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center center;
}
```

- [x] **Step 4: Replace `.carousel-thumbnails` positioning**

Replace the existing `.carousel-thumbnails` rule with:

```css
.carousel-thumbnail-zone {
  position: absolute;
  z-index: 3;
  right: 0;
  bottom: 0;
  left: 0;
  height: 132px;
  pointer-events: none;
}

.carousel-thumbnail-zone::before {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 100%;
  content: "";
  pointer-events: auto;
}

.carousel-thumbnails {
  position: absolute;
  right: auto;
  bottom: 14px;
  left: 50%;
  display: flex;
  width: min(calc(100% - 28px), 1240px);
  max-width: calc(100% - 28px);
  justify-content: center;
  gap: 8px;
  overflow-x: auto;
  padding: 2px;
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, 8px);
  transition:
    opacity 160ms ease,
    transform 160ms ease;
}

.carousel-thumbnail-zone:hover .carousel-thumbnails,
.carousel-thumbnail-zone:focus-within .carousel-thumbnails {
  opacity: 1;
  pointer-events: auto;
  transform: translate(-50%, 0);
}
```

- [x] **Step 5: Add thumbnail image center positioning**

Update the existing thumbnail image rule:

```css
.carousel-thumbnail img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center center;
}
```

- [x] **Step 6: Update mobile and no-hover behavior**

Replace the mobile `.carousel-thumbnails` offsets with:

```css
.carousel-thumbnail-zone {
  height: 106px;
}

.carousel-thumbnails {
  bottom: 10px;
  width: min(calc(100% - 20px), 1240px);
  max-width: calc(100% - 20px);
}
```

Add this no-hover media block outside the mobile media block:

```css
@media (hover: none) {
  .carousel-thumbnails {
    opacity: 1;
    pointer-events: auto;
    transform: translate(-50%, 0);
  }
}
```

- [x] **Step 7: Run style tests**

Run:

```bash
pnpm --filter @platforma/web test
```

Expected: FAIL only if modal CSS is not implemented yet.

---

### Task 5: Add Modal Styles

**Files:**
- Modify: `apps/web/src/styles.css`

- [x] **Step 1: Add modal backdrop and shell styles near carousel styles**

```css
.carousel-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: grid;
  place-items: center;
  background: rgb(10 15 22 / 88%);
  padding: 24px;
}

.carousel-modal {
  position: relative;
  display: grid;
  width: 100%;
  height: 100%;
  place-items: center;
}
```

- [x] **Step 2: Add contained original image styles**

```css
.carousel-modal-image {
  display: grid;
  max-width: 100%;
  max-height: 100%;
  place-items: center;
}

.carousel-modal-image img {
  display: block;
  width: auto;
  height: auto;
  max-width: calc(100vw - 48px);
  max-height: calc(100dvh - 112px);
  object-fit: contain;
  object-position: center center;
}
```

- [x] **Step 3: Add modal controls**

```css
.carousel-modal-close,
.carousel-modal-button,
.carousel-modal-counter {
  position: absolute;
  z-index: 2;
  border: 1px solid rgb(255 255 255 / 42%);
  background: rgb(24 32 42 / 78%);
  color: #ffffff;
}

.carousel-modal-close,
.carousel-modal-button {
  display: grid;
  place-items: center;
  border-radius: 999px;
  padding: 0;
}

.carousel-modal-close {
  top: 0;
  right: 0;
  width: 42px;
  height: 42px;
  font-size: 28px;
  line-height: 1;
}

.carousel-modal-button {
  top: 50%;
  width: 46px;
  height: 46px;
  font-size: 32px;
  line-height: 1;
  transform: translateY(-50%);
}

.carousel-modal-button--previous {
  left: 0;
  padding-bottom: 3px;
}

.carousel-modal-button--next {
  right: 0;
  padding-bottom: 3px;
}

.carousel-modal-counter {
  right: 0;
  bottom: 0;
  border-radius: 999px;
  padding: 7px 10px;
  font-size: 12px;
  font-weight: 800;
}
```

- [x] **Step 4: Add mobile modal adjustments**

Inside `@media (max-width: 760px)`, add:

```css
.carousel-modal-backdrop {
  padding: 14px;
}

.carousel-modal-image img {
  max-width: calc(100vw - 28px);
  max-height: calc(100dvh - 96px);
}

.carousel-modal-button {
  width: 38px;
  height: 38px;
  font-size: 28px;
}

.carousel-modal-close {
  width: 38px;
  height: 38px;
}
```

- [x] **Step 5: Run web tests**

Run:

```bash
pnpm --filter @platforma/web test
```

Expected: PASS.

---

### Task 6: Build Verification And Manual QA

**Files:**
- No code edits expected in this task.

- [ ] **Step 1: Run production web build**

Run:

```bash
pnpm build:web
```

Expected: PASS.

- [ ] **Step 2: Run local web server on the required port**

Run:

```bash
pnpm dev:web -- --port 5173 --strictPort
```

Expected: Vite starts on port `5173`. If the port is already busy, stop the existing process or ask the user before using another port.

- [ ] **Step 3: Manually verify desktop behavior**

Open an object detail page with several gallery images and check:

- [ ] Miniatures are hidden when the cursor is outside the lower carousel zone.
- [ ] Miniatures appear when the cursor enters the lower zone of the carousel.
- [ ] Miniature rail is centered when there are few images.
- [ ] Miniature rail scrolls horizontally when there are many images.
- [ ] Main image is visually centered inside the carousel.
- [ ] Clicking the main image opens the modal.
- [ ] Modal image is fully visible without cropping.
- [ ] Modal arrows switch original images.
- [ ] Counter updates correctly in the modal.
- [ ] Close button, backdrop click, and `Escape` close the modal.

- [ ] **Step 4: Manually verify mobile/no-hover behavior**

Check a narrow viewport or touch device:

- [ ] Miniatures remain visible without hover.
- [ ] Miniatures remain usable as image switches.
- [ ] Modal image stays contained in the viewport.
- [ ] Modal controls do not overlap the image in a way that blocks inspection.

---

### Task 7: Final Check Before Reporting

- [ ] **Step 1: Check git status**

Run:

```bash
git status --short
```

Expected: only intentional files are changed:

```text
 M apps/web/src/objects/ObjectDetailPage.tsx
 M apps/web/src/styles.css
 M apps/web/tests/object-detail-styles.test.mjs
?? apps/web/tests/object-detail-carousel.test.mjs
```

The existing untracked `.playwright-mcp/console-2026-05-14T13-54-22-429Z.log` may still be present and must remain untouched.

- [ ] **Step 2: Final response checklist**

In the final response, include:

- [ ] what was implemented;
- [ ] changed files;
- [ ] commands run and whether they passed;
- [ ] what should be checked manually;
- [ ] any disputed or risky points.
