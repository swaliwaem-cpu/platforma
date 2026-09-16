// HTML template of the project presentation PDF (подборка ЖК).
// The API prints it with Chromium, the editor shows the same markup in its preview.
// Sizes are CSS pixels of a 720×960 page (= 540×720 pt), copied from the approved reference PDF.

export const PROJECT_PRESENTATION_PAGE_SIZE = Object.freeze({ width: 720, height: 960 });
export const PROJECT_PRESENTATION_MAP_SIZE = Object.freeze({ width: 648, height: 735 });
export const PROJECT_PRESENTATION_MAP_VIEW = Object.freeze({
  padding: 96,
  maxZoom: 14,
  singlePointZoom: 13,
  defaultCenter: Object.freeze([37.6173, 55.7558]),
  defaultZoom: 9.6,
});
export const PROJECT_PRESENTATION_LIMITS = Object.freeze({
  coverTitle: 60,
  coverSubtitle: 120,
  clientName: 60,
  mapTitle: 60,
  description: 430,
  advantage: 40,
  advantages: 4,
  images: 3,
});
export const PROJECT_PRESENTATION_FONT_FILES = Object.freeze([
  'Involve-Regular.woff2',
  'Involve-Medium.woff2',
  'Inter-Regular.woff2',
  'Inter-Medium.woff2',
  'Lora-Italic.woff2',
]);
// Instagram and YouTube stay placeholders until the real accounts are provided.
export const PROJECT_PRESENTATION_LINKS = Object.freeze({
  telegram: 'https://t.me/FluffyWhite',
  instagram: null,
  youtube: null,
});
export const PROJECT_PRESENTATION_DEFAULT_PHONE = '+7 (495) 492-48-58';
export const PROJECT_PRESENTATION_DEFAULT_MAP_TITLE = 'Москва, в которой хочется жить';

export function truncateProjectPresentationDescription(value, limit = PROJECT_PRESENTATION_LIMITS.description) {
  const text = String(value ?? '').replace(/\s+/gu, ' ').trim();
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit - 1);
  const wordBoundary = slice.replace(/\s+\S*$/u, '');
  return `${(wordBoundary || slice).replace(/[\s,.;:—–-]+$/u, '')}…`;
}

export function getProjectPresentationPageKeys(projectKeys) {
  return ['cover', 'map', ...projectKeys, 'company', 'final'];
}

// Positions markers without a map image: equirectangular fit inside the padded map frame.
export function getProjectPresentationFallbackMarkers(points) {
  const valid = points.filter((point) => isCoordinate(point.latitude, point.longitude));
  if (!valid.length) return [];
  const { width, height } = PROJECT_PRESENTATION_MAP_SIZE;
  const { padding } = PROJECT_PRESENTATION_MAP_VIEW;
  const latitudes = valid.map((point) => point.latitude);
  const longitudes = valid.map((point) => point.longitude);
  const centerLatitude = (Math.min(...latitudes) + Math.max(...latitudes)) / 2;
  const centerLongitude = (Math.min(...longitudes) + Math.max(...longitudes)) / 2;
  const longitudeScale = Math.cos((centerLatitude * Math.PI) / 180);
  const spanX = Math.max((Math.max(...longitudes) - Math.min(...longitudes)) * longitudeScale, 1e-6);
  const spanY = Math.max(Math.max(...latitudes) - Math.min(...latitudes), 1e-6);
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY, 20_000);
  return valid.map((point) => ({
    x: width / 2 + (point.longitude - centerLongitude) * longitudeScale * scale,
    y: height / 2 - (point.latitude - centerLatitude) * scale,
  }));
}

export function renderProjectPresentationHtml(model, options) {
  const keys = options.pageKeys ? new Set(options.pageKeys) : null;
  const include = (key) => !keys || keys.has(key);
  const pages = [];
  if (include('cover')) pages.push(renderCover(model.cover));
  if (include('map')) pages.push(renderMap(model.map));
  for (const project of model.projects) {
    if (include(project.key)) pages.push(renderProject(project, model.contacts.ctaUrl));
  }
  if (include('company')) pages.push(renderCompany());
  if (include('final')) pages.push(renderFinal(model.contacts));

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escapeHtml(model.cover.title)}</title>`
    + `<style>${renderFontFaces(options.fontUrls)}${templateCss}</style></head>`
    + `<body>${pages.join('')}<script>${fitScript}</script></body></html>`;
}

function renderCover(cover) {
  const features = [
    ['building', 'Локация и факты', 'Район, метро и класс'],
    ['heart', 'Преимущества', 'Главное о каждом ЖК'],
    ['layers', 'Старты продаж', 'Новые предложения'],
    ['fileText', 'Условия покупки', 'Стоимость и рассрочка'],
  ];
  return `<section class="fw-page fw-cover" data-page="cover">
<header class="fw-cover__top"><span class="fw-wordmark">FluffyWhite</span>${cover.issueLabel ? `<span class="fw-pill">${text(cover.issueLabel)}</span>` : ''}</header>
<div class="fw-cover__head">
<h1 class="fw-cover__title" data-fit data-fit-lines="2" data-fit-min="40">${text(cover.title)}</h1>
<div class="fw-cover__aside" data-fit data-fit-height="174" data-fit-min="10">${cover.subtitle ? `<p class="fw-cover__subtitle">${text(cover.subtitle)}</p>` : ''}${cover.clientName ? `<p class="fw-cover__client">Подготовлено для <b>${text(cover.clientName)}</b></p>` : ''}</div>
</div>
<div class="fw-cover__photo">${image(cover.imageSrc)}</div>
<div class="fw-cover__features">${features.map(([name, title, caption]) => `<div class="fw-feature"><span class="fw-icon-tile">${icon(name, 22)}</span><div><strong>${title}</strong><span>${caption}</span></div></div>`).join('')}</div>
</section>`;
}

function renderMap(map) {
  const markers = map.markers
    .filter((marker) => Number.isFinite(marker.x) && Number.isFinite(marker.y))
    .map((marker) => `<span class="fw-map__marker" style="left:${round(marker.x)}px;top:${round(marker.y)}px"></span>`)
    .join('');
  return `<section class="fw-page fw-map" data-page="map">
<header class="fw-map__head"><h2 class="fw-map__title" data-fit data-fit-lines="2" data-fit-min="36">${text(map.title)}</h2><p class="fw-map__note">Локации проектов<br>вашей подборки.</p></header>
<div class="fw-map__frame${map.imageSrc ? '' : ' is-empty'}">${map.imageSrc ? `<img src="${escapeHtml(map.imageSrc)}" alt="">` : ''}${markers}</div>
</section>`;
}

function renderProject(project, ctaUrl) {
  const { price, prefix } = splitPrice(project.price);
  const advantages = project.advantages.map((value) => value.trim()).filter(Boolean).slice(0, PROJECT_PRESENTATION_LIMITS.advantages);
  const [mainImage = null, firstDetail = null, secondDetail = null] = project.imageSrcs;
  return `<section class="fw-page fw-project" data-page="${escapeHtml(project.key)}">
<header class="fw-project__head">
<h2 class="fw-project__title" data-fit data-fit-lines="2" data-fit-min="36">${text(project.title)}</h2>
${project.description ? `<p class="fw-project__description" data-fit data-fit-min="12">${text(project.description)}</p>` : ''}
</header>
<div class="fw-project__top">
<div class="fw-photo fw-photo--main">${image(mainImage)}</div>
<div class="fw-facts">
${ringsSvg('fw-facts__rings', 150, 150, '#59222b', [78, 116, 154, 192])}
<p class="fw-facts__label">Стоимость</p>
<p class="fw-facts__price" data-fit data-fit-lines="1" data-fit-min="14">${prefix ? `<span class="fw-facts__from">${prefix}</span>` : ''}<strong>${prefix ? ' ' : ''}${escapeHtml(price)}</strong></p>
<dl class="fw-facts__rows">
<div class="fw-facts__row"><dt>Класс</dt><dd data-fit data-fit-lines="1" data-fit-min="12">${text(project.propertyClass)}</dd></div>
<div class="fw-facts__row"><dt>Метро</dt><dd data-fit data-fit-lines="1" data-fit-min="12">${text(project.metro)}</dd></div>
</dl>
<p class="fw-facts__label fw-facts__label--list">Основные преимущества</p>
<ol class="fw-facts__list">${advantages.map((advantage, index) => `<li><span class="fw-facts__number">${String(index + 1).padStart(2, '0')}</span><span class="fw-facts__advantage" data-fit data-fit-lines="1" data-fit-min="12">${text(advantage)}</span></li>`).join('')}</ol>
<a class="fw-button fw-button--details" href="${escapeHtml(ctaUrl)}"><span>Узнать подробности</span><span class="fw-button__arrow">${icon('arrowRight', 16)}</span></a>
</div>
</div>
<div class="fw-project__bottom"><div class="fw-photo">${image(firstDetail)}</div><div class="fw-photo">${image(secondDetail)}</div></div>
</section>`;
}

function renderCompany() {
  const services = [
    ['shieldCheck', 'Полное сопровождение', 'Документы и сделка под контролем от<br>подбора до получения ключей — на<br>связи почти 24/7.'],
    ['tag', 'Специальные условия', 'Знаем обо всех акциях и закрытых<br>продажах, договариваемся о<br>дополнительной выгоде.'],
    ['scale', 'Честный подход', 'Говорим не только о плюсах, но и о<br>минусах объектов — выбор всегда<br>объективный.'],
    ['searchChart', 'Независимый анализ', 'Не привязаны к одному ЖК, сравниваем<br>рынок по многим параметрам.'],
  ];
  return `<section class="fw-page fw-company" data-page="company">
<p class="fw-kicker"><span class="fw-kicker__dot"></span>О компании</p>
<h2 class="fw-company__statement">Наша главная цель — найти вам<br><em>лучший объект</em>, а не продать то,<br>что есть в наличии</h2>
<div class="fw-benefit">
${ringsSvg('fw-benefit__rings', 250, 249, '#622b34', [40, 78, 116, 154, 192], 200, 80)}
<p class="fw-benefit__label">Почему это выгодно</p>
<p class="fw-benefit__title">Работаем<br>бесплатно для вас</p>
<p class="fw-benefit__text">Цена квартиры не меняется и получается выгоднее,<br>чем у застройщика.</p>
</div>
<div class="fw-company__services">${services.map(([name, title, description], index) => `<div class="fw-service"><span class="fw-icon-tile fw-icon-tile--small">${icon(name, 22)}</span><span class="fw-service__number">${String(index + 1).padStart(2, '0')}</span><strong>${title}</strong><p>${description}</p></div>`).join('')}</div>
</section>`;
}

function renderFinal(contacts) {
  const steps = [
    'Подбор<br>вариантов<br>жилых<br>комплексов по<br>вашим<br>параметрам',
    'Проведение<br>показов<br>непосредственно<br>на стройке',
    'Анализ<br>конкурентов и<br>альтернатив',
    'Бронирование и<br>заключение<br>договора с<br>застройщиком',
    'Регистрация<br>прав на вашу<br>квартиру',
  ];
  const phone = formatPhone(contacts.phone) || PROJECT_PRESENTATION_DEFAULT_PHONE;
  const phoneHref = `tel:${phone.replace(/[^\d+]/gu, '')}`;
  const socials = [
    ['Instagram', PROJECT_PRESENTATION_LINKS.instagram],
    ['Telegram', PROJECT_PRESENTATION_LINKS.telegram],
    ['YouTube', PROJECT_PRESENTATION_LINKS.youtube],
  ];
  return `<section class="fw-page fw-final" data-page="final">
<header class="fw-final__head"><h2 class="fw-final__title">С нами вы пройдёте<br>весь путь:</h2><p class="fw-final__note">Сопровождаем<br>покупку на<br>каждом этапе.</p></header>
<ol class="fw-steps">${steps.map((step, index) => `<li${index === steps.length - 1 ? ' class="is-final"' : ''}><span class="fw-steps__number">${String(index + 1).padStart(2, '0')}</span><span class="fw-steps__label">${step}</span></li>`).join('')}</ol>
<div class="fw-start">
${ringsSvg('fw-start__rings', 230, 190, '#622b34', [40, 78, 116, 154, 192])}
<p class="fw-start__quote">С FluffyWhite вы не просто покупаете квартиру.<br>Вы получаете уверенность, спокойствие, опору.</p>
<div class="fw-start__row"><p class="fw-start__title">Начните подбор<br>недвижимости с<br>FluffyWhite</p><a class="fw-button fw-button--start" href="${escapeHtml(contacts.ctaUrl)}"><span>Начать подбор</span><span class="fw-button__arrow">${icon('arrowRight', 16)}</span></a></div>
</div>
<div class="fw-contacts">
<h2 class="fw-contacts__title">Наши контакты</h2>
<p class="fw-contacts__note">Свяжитесь с нами удобным<br>способом.</p>
<span class="fw-contacts__label">Номер телефона</span>
<a class="fw-contacts__phone" href="${escapeHtml(phoneHref)}" data-fit data-fit-lines="1" data-fit-min="24">${escapeHtml(phone)}</a>
<div class="fw-socials">${socials.map(([label, href]) => `<${href ? `a href="${escapeHtml(href)}"` : 'span'} class="fw-social"><span>${label}</span><span class="fw-social__arrow">${icon('arrowUpRight', 14)}</span></${href ? 'a' : 'span'}>`).join('')}</div>
</div>
</section>`;
}

// Russian numbers are shown like the reference: +7 (495) 492-48-58; anything else stays as entered.
function formatPhone(value) {
  const raw = String(value ?? '').trim();
  const digits = raw.replace(/\D/gu, '');
  if (digits.length !== 11 || !/^[78]/u.test(digits)) return raw;
  return `+7 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9)}`;
}

function splitPrice(value) {
  const normalized = String(value ?? '').replace(/\s+/gu, ' ').trim() || 'По запросу';
  const match = /^от\s+(.+)$/iu.exec(normalized);
  return match ? { prefix: 'от', price: match[1] } : { prefix: '', price: normalized };
}

function image(src) {
  return src ? `<img src="${escapeHtml(src)}" alt="">` : '';
}

function ringsSvg(className, width, height, color, radii, centerX = 200, centerY = 200) {
  return `<svg class="${className}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${radii.map((radius) => `<circle cx="${centerX}" cy="${centerY}" r="${radius}" fill="none" stroke="${color}" stroke-width="1"/>`).join('')}</svg>`;
}

function icon(name, size) {
  const strokeWidth = name.startsWith('arrow') ? 1.8 : 1.6;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
}

// Glyphs traced from the reference PDF (24×24 grid).
const icons = {
  building: '<path d="M4 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16"/><path d="M14 9h5a1 1 0 0 1 1 1v11"/><path d="M2.5 21h19"/><path d="M7.5 8h3M7.5 12h3M7.5 16h3M17 13.5v.01M17 17v.01"/>',
  heart: '<path d="M12 20C12 20 4.5 15.7 4.5 9.8C4.55 8.93 4.84 8.16 5.37 7.46C5.89 6.77 6.56 6.28 7.38 6C8.2 5.72 9.03 5.68 9.87 5.9C10.71 6.12 11.42 6.55 12 7.2C12.58 6.55 13.29 6.12 14.13 5.9C14.97 5.68 15.8 5.72 16.62 6C17.44 6.28 18.11 6.77 18.63 7.46C19.16 8.16 19.45 8.93 19.5 9.8C19.5 15.7 12 20 12 20"/>',
  layers: '<path d="M12 3.5 21 8.2l-9 4.7-9-4.7z"/><path d="m3 12.2 9 4.7 9-4.7"/><path d="m3 16.2 9 4.7 9-4.7"/>',
  fileText: '<path d="M14 3H6.8a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h10.4a1 1 0 0 0 1-1V7.2L14 3"/><path d="M14 3v4.2h4.2"/><path d="M9 12.5h6M9 16.5h4"/>',
  shieldCheck: '<path d="M12 3 5 5.8v5.4c0 4.4 3 7.9 7 9.8 4-1.9 7-5.4 7-9.8V5.8L12 3"/><path d="m9 12 2.2 2.2 4-4.2"/>',
  tag: '<path d="m20.2 13.3-6.9 6.9a1.9 1.9 0 0 1-2.7 0l-7.1-7.1V3.5h9.6l7.1 7.1a1.9 1.9 0 0 1 0 2.7"/><circle cx="8" cy="8" r="1.4"/>',
  scale: '<path d="M12 4v16M8 20h8M5 7.5h14M12 4.5v3"/><path d="m5 7.5-2.5 5.5a2.5 2.5 0 0 0 5 0L5 7.5"/><path d="m19 7.5-2.5 5.5a2.5 2.5 0 0 0 5 0L19 7.5"/>',
  searchChart: '<circle cx="10.5" cy="10.5" r="7"/><path d="m20.5 20.5-5-5"/><path d="M7.5 13v-1.5M10.5 13V8M13.5 13v-3"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  arrowUpRight: '<path d="M7 17 17 7"/><path d="M8.5 7H17v8.5"/>',
};

function renderFontFaces(fontUrls) {
  const face = (family, file, weight, style = 'normal') => `@font-face{font-family:"${family}";src:url("${escapeHtml(fontUrls[file])}") format("woff2");font-weight:${weight};font-style:${style};font-display:block}`;
  return face('FW Display', 'Involve-Regular.woff2', 400)
    + face('FW Display', 'Involve-Medium.woff2', 500)
    + face('FW Text', 'Inter-Regular.woff2', 400)
    + face('FW Text', 'Inter-Medium.woff2', 500)
    + face('FW Serif', 'Lora-Italic.woff2', 400, 'italic');
}

// Collapses whitespace from user input but keeps intentional non-breaking spaces (U+00A0).
function text(value) {
  return escapeHtml(String(value ?? '').replace(/[^\S\u{a0}]+/gu, ' ').trim());
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function isCoordinate(latitude, longitude) {
  return typeof latitude === 'number' && typeof longitude === 'number'
    && Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

// Shrinks marked text until it fits: data-fit-lines caps the line count, data-fit-height caps the height,
// otherwise the text may use the space left in its parent. Whatever still overflows is clamped.
const fitScript = `(() => {
  const fit = (element) => {
    const minimum = Number(element.dataset.fitMin || 10);
    const style = getComputedStyle(element);
    let size = parseFloat(style.fontSize);
    const ratio = parseFloat(style.lineHeight) / size;
    const lineHeight = () => ratio * size;
    const maxLines = () => {
      if (element.dataset.fitLines) return Number(element.dataset.fitLines);
      const parentBottom = element.parentElement.getBoundingClientRect().bottom;
      return Math.max(1, Math.floor((parentBottom - element.getBoundingClientRect().top + 0.5) / lineHeight()));
    };
    const tooBig = () => {
      const height = element.getBoundingClientRect().height;
      if (element.scrollWidth > element.clientWidth + 1) return true;
      if (element.dataset.fitHeight) return height > Number(element.dataset.fitHeight) + 0.5;
      return Math.round(height / lineHeight()) > maxLines();
    };
    while (tooBig() && size > minimum) {
      size -= 1;
      element.style.fontSize = size + 'px';
      element.style.lineHeight = lineHeight() + 'px';
    }
    if (tooBig() && !element.dataset.fitHeight) {
      element.style.display = '-webkit-box';
      element.style.webkitBoxOrient = 'vertical';
      element.style.webkitLineClamp = String(maxLines());
      element.style.overflow = 'hidden';
    }
  };
  const images = Array.from(document.images).map((img) => img.complete ? null : new Promise((resolve) => { img.onload = img.onerror = resolve; }));
  Promise.all([document.fonts ? document.fonts.ready : null, ...images]).then(() => {
    document.querySelectorAll('[data-fit]').forEach(fit);
    document.documentElement.dataset.ready = 'true';
  });
})();`;

const templateCss = `
@page{size:720px 960px;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#f1efe9}
body{color:#141713;font-family:"FW Text",sans-serif;font-weight:400;-webkit-print-color-adjust:exact;print-color-adjust:exact;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
b,strong{font-weight:500}
ol{list-style:none}
img{display:block;width:100%;height:100%;object-fit:cover}
.fw-page{position:relative;width:720px;height:960px;overflow:hidden;background:#f1efe9;break-after:page}
.fw-page:last-child{break-after:auto}
.fw-icon-tile{display:grid;flex:none;width:48px;height:48px;place-items:center;border-radius:15px;background:#f3e4e6;color:#430a13}
.fw-icon-tile--small{width:46px;height:46px;border-radius:14px}
.fw-icon-tile svg{display:block}
.fw-photo{overflow:hidden;border-radius:26px;background:#ddd9d0}
.fw-button{display:flex;align-items:center;justify-content:space-between;height:48px;border-radius:24px;background:#f4f2eb;color:#141713;font-size:14px;line-height:17px}
.fw-button__arrow{display:grid;width:36px;height:36px;place-items:center;border-radius:50%;background:#430a13;color:#f4f2eb}
.fw-cover__top{position:absolute;top:30px;right:36px;left:36px;display:flex;height:29px;align-items:center;justify-content:space-between}
.fw-wordmark{position:relative;top:1px;font:500 19px/19px "FW Display";letter-spacing:-.01em}
.fw-pill{display:flex;height:29px;align-items:center;padding:0 12.5px;border:1px solid #d9d5cb;border-radius:999px;color:#63685f;font-size:12px;line-height:15px;white-space:nowrap}
.fw-cover__head{position:absolute;top:112px;right:36px;left:36px;display:grid;height:180px;grid-template-columns:minmax(0,1fr) 170px}
.fw-cover__title{align-self:start;margin-left:-5px;font:400 100px/.9 "FW Display";letter-spacing:-.045em;text-transform:uppercase;text-wrap:balance}
.fw-cover__aside{max-height:174px;align-self:end;margin-bottom:6px;overflow:hidden;color:#63685f;font-size:14px;line-height:20.5px}
.fw-cover__client{margin-top:10px}
.fw-cover__client b{color:#141713}
.fw-cover__photo{position:absolute;top:332px;left:0;width:720px;height:470px;background:#ddd9d0}
.fw-cover__features{position:absolute;top:724px;right:36px;left:36px;display:grid;gap:10px;grid-template-columns:1fr 1fr}
.fw-feature{display:flex;height:84px;align-items:center;gap:16px;padding-left:20px;border-radius:22px;background:#fff}
.fw-feature strong{display:block;font:500 19px/19px "FW Display";letter-spacing:-.01em}
.fw-feature span{display:block;margin-top:8px;color:#63685f;font-size:13px;line-height:15.7px}
.fw-map__head{position:absolute;top:30px;right:36px;left:36px;display:flex;align-items:last baseline;justify-content:space-between}
.fw-map__title{max-width:480px;font:400 66px/64.9px "FW Display";letter-spacing:-.035em;text-wrap:balance}
.fw-map__note{position:relative;top:-1px;flex:none;color:#63685f;font-size:14px;line-height:20px;text-align:right}
.fw-map__frame{position:absolute;top:189px;left:36px;width:648px;height:735px;overflow:hidden;border-radius:28px;background:#e4e0d7}
.fw-map__marker{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border:4px solid #f4f2eb;border-radius:50%;background:#430a13;box-shadow:0 0 0 6px rgba(67,10,19,.16),0 3px 10px rgba(20,23,19,.3)}
.fw-project__head{position:absolute;top:30px;left:36px;width:648px;height:273px;overflow:hidden}
.fw-project__title{font:400 60px/60px "FW Display";letter-spacing:-.035em;text-wrap:balance}
.fw-project__description{margin-top:13px;color:#63685f;font-size:15px;line-height:23px;text-wrap:pretty}
.fw-project__top{position:absolute;top:303px;left:36px;display:flex;height:439px;gap:12px}
.fw-photo--main{width:373px}
.fw-project__bottom{position:absolute;top:754px;left:36px;display:grid;width:648px;height:170px;gap:12px;grid-template-columns:1fr 1fr}
.fw-facts{position:relative;display:flex;width:263px;flex-direction:column;padding:25px 22px 22px;overflow:hidden;border-radius:26px;background:#430a13;color:#f4f2eb}
.fw-facts>*{position:relative}
.fw-facts .fw-facts__rings{position:absolute;right:0;bottom:0}
.fw-facts__label{color:#cfa1a8;font-size:12px;line-height:14.5px}
.fw-facts__price{height:30px;margin-top:5px;overflow:hidden;font-size:25px;line-height:30px;white-space:nowrap}
.fw-facts__from{color:#e8d2d5;font-size:15px;line-height:15px}
.fw-facts__price strong{letter-spacing:-.02em}
.fw-facts__rows{margin-top:18.5px}
.fw-facts__row{display:flex;height:38px;align-items:baseline;padding-top:10px;justify-content:space-between;gap:12px;border-top:1px solid #5c2b31}
.fw-facts__row:last-child{height:39px;border-bottom:1px solid #5c2b31}
.fw-facts__row dt{flex:none;color:#cfa1a8;font-size:12px;line-height:14.5px}
.fw-facts__row dd{min-width:0;overflow:hidden;font-size:14.5px;font-weight:500;line-height:17.5px;text-align:right;white-space:nowrap}
.fw-facts__label--list{margin-top:21px}
.fw-facts__list{margin-top:2.7px}
.fw-facts__list li{display:flex;height:36.67px;align-items:baseline;padding-top:9.2px;border-bottom:1px solid #5c2b31}
.fw-facts__number{flex:none;width:30px;color:#cfa1a8;font:400 12px/16px "FW Display"}
.fw-facts__advantage{min-width:0;overflow:hidden;font-size:13.5px;line-height:16px;white-space:nowrap}
.fw-button--details{margin-top:auto;padding:0 6px 0 20px}
.fw-kicker{position:absolute;top:30px;left:40px;display:flex;align-items:center;gap:10px;color:#63685f;font-size:13px;line-height:24px}
.fw-kicker__dot{width:8px;height:8px;border-radius:50%;background:#430a13}
.fw-company__statement{position:absolute;top:67px;left:40px;font:italic 400 37px/43px "FW Serif";letter-spacing:-.015em;white-space:nowrap}
.fw-company__statement em{color:#430a13;font-style:inherit}
.fw-benefit{position:absolute;top:225px;left:36px;width:648px;height:249px;padding:28.5px 34px 0;overflow:hidden;border-radius:28px;background:#430a13}
.fw-benefit>*{position:relative}
.fw-benefit .fw-benefit__rings{position:absolute;top:0;left:398px}
.fw-benefit__label{color:#cfa1a8;font-size:13px;line-height:15.7px}
.fw-benefit__title{margin-top:15.6px;color:#f4f2eb;font:400 49px/49px "FW Display";letter-spacing:-.035em}
.fw-benefit__text{margin-top:15.8px;color:#e8d2d5;font-size:15px;line-height:22px}
.fw-company__services{position:absolute;top:486px;left:36px;display:grid;width:648px;gap:12px;grid-auto-rows:213px;grid-template-columns:1fr 1fr}
.fw-service{position:relative;padding:20px 22px 0;border-radius:24px;background:#fff}
.fw-service__number{position:absolute;top:21.6px;right:22px;color:#979b92;font:400 13px/13px "FW Display"}
.fw-service strong{display:block;margin-top:19.2px;font:500 21px/21px "FW Display";letter-spacing:-.015em}
.fw-service p{margin-top:11.9px;color:#63685f;font-size:13.5px;line-height:20px}
.fw-final__head{position:absolute;top:34px;right:40px;left:40px;display:flex;align-items:last baseline;justify-content:space-between}
.fw-final__title{font:400 50px/50px "FW Display";letter-spacing:-.035em}
.fw-final__note{color:#63685f;font-size:14px;line-height:20.4px;text-align:right}
.fw-steps{position:absolute;top:164px;left:36px;display:grid;width:648px;padding:28px 20px;column-gap:10px;grid-template-columns:repeat(5,1fr);border-radius:26px;background:#fff}
.fw-steps::before{position:absolute;top:50.5px;left:44px;width:508px;height:1px;background:repeating-linear-gradient(90deg,#c9c4b8 0 3px,transparent 3px 5px);content:""}
.fw-steps li{position:relative}
.fw-steps__number{display:grid;width:46px;height:46px;place-items:center;padding-bottom:2px;border:1px solid #d3cfc5;border-radius:50%;background:#fff;font:400 15px/15px "FW Display"}
.fw-steps .is-final .fw-steps__number{border-color:#430a13;background:#430a13;color:#f4f2eb}
.fw-steps__label{display:block;margin-top:16.1px;font-size:12.5px;font-weight:500;line-height:17.6px}
.fw-start{position:absolute;top:399px;left:36px;width:648px;height:261px;padding:29.5px 32px 0;overflow:hidden;border-radius:28px;background:#430a13}
.fw-start>*{position:relative}
.fw-start .fw-start__rings{position:absolute;top:71px;left:418px}
.fw-start__quote{padding-bottom:24.5px;border-bottom:1px solid #5c2b31;color:#e8d2d5;font:italic 400 22px/31px "FW Serif"}
.fw-start__row{display:flex;align-items:center;justify-content:space-between;margin-top:23.5px}
.fw-start__title{color:#f4f2eb;font:500 25px/30px "FW Display";letter-spacing:-.015em}
.fw-button--start{width:186px;padding:0 6px 0 22px;font-weight:500}
.fw-contacts{position:absolute;top:672px;left:36px;width:648px;height:252px;border-radius:26px;background:#fff}
.fw-contacts__title{position:absolute;top:38.4px;left:26px;font:500 27px/27px "FW Display";letter-spacing:-.015em}
.fw-contacts__note{position:absolute;top:25.6px;right:26px;color:#63685f;font-size:13.5px;line-height:19px;text-align:right}
.fw-contacts::before{position:absolute;top:86px;right:26px;left:26px;height:1px;background:#e3dfd6;content:""}
.fw-contacts__label{position:absolute;top:131.4px;left:26px;color:#63685f;font-size:12px;line-height:14.5px}
.fw-contacts__phone{position:absolute;top:107.2px;right:26px;max-width:450px;height:46px;overflow:hidden;font:400 46px/46px "FW Display";letter-spacing:-.025em;white-space:nowrap}
.fw-socials{position:absolute;top:172px;right:26px;left:26px;display:grid;gap:10px;grid-template-columns:repeat(3,1fr)}
.fw-social{display:flex;height:58px;align-items:center;justify-content:space-between;padding:0 14px 0 18px;border-radius:16px;background:#f1efe9;font-size:14px;font-weight:500;line-height:17px}
.fw-social__arrow{display:grid;width:30px;height:30px;place-items:center;border-radius:50%;background:#fff}
/* The reference is set without kerning; the font shorthands above would reset it. */
.fw-page,.fw-page *{font-kerning:none!important}
`;
