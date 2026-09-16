import { existsSync, readFileSync } from 'node:fs';

import { Injectable, Logger } from '@nestjs/common';
import { chromium, type Browser, type Page } from 'playwright-core';
import sharp from 'sharp';

import { FilesService } from '../files/files.service';
import {
  loadProjectPresentationTemplate,
  resolveProjectPresentationFontPath,
  type ProjectPresentationTemplateModule,
} from './project-presentation-template';
import {
  getProjectPresentationMapConfig,
  renderProjectPresentationMap,
  type ProjectPresentationMapPoint,
  type ProjectPresentationMapSnapshot,
} from './project-presentations-map';
import { ProjectPresentationSnapshot, ProjectPresentationSnapshotImage } from './project-presentations.types';

type TemplateModel = Parameters<ProjectPresentationTemplateModule['renderProjectPresentationHtml']>[0];
type TemplateFontUrls = Parameters<ProjectPresentationTemplateModule['renderProjectPresentationHtml']>[1]['fontUrls'];
type ImageSlot = { key: string; image: ProjectPresentationSnapshotImage; width: number; height: number };
type Progress = ((progress: number) => Promise<void>) | undefined;

// Chromium only talks to this virtual origin while printing; every asset is served from memory.
const assetOrigin = 'https://presentation.invalid';
const renderTimeoutMs = 60_000;
const imageConcurrency = 4;
const mapProgress = { start: 60, page: 62, busyLimit: 72, map: 73 } as const;
const mapProgressTickMs = 2_000;
// Image boxes of the template (CSS px), rendered at 2x for print.
const imageBoxes = {
  cover: { width: 720, height: 470 },
  main: { width: 373, height: 439 },
  detail: { width: 318, height: 170 },
};
// Alpine Chromium has no SwiftShader: on GPU-less Linux servers WebGL (MapLibre) runs through
// ANGLE on Mesa llvmpipe (mesa-egl, mesa-gles, mesa-dri-gallium in the API image).
const browserArgs = process.platform === 'linux'
  ? ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist']
  : [];
const browserCandidates = [
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

@Injectable()
export class ProjectPresentationsPdfService {
  private readonly logger = new Logger(ProjectPresentationsPdfService.name);

  constructor(private readonly filesService: FilesService) {}

  async generate(snapshot: ProjectPresentationSnapshot, onProgress?: (progress: number) => Promise<void>) {
    const startedAt = Date.now();
    const template = await loadProjectPresentationTemplate();
    const assets = await this.loadImages(snapshot, onProgress);
    const imagesLoadedAt = Date.now();
    const browser = await chromium.launch({
      headless: true,
      executablePath: resolveBrowserExecutablePath(),
      args: browserArgs,
    });
    try {
      await onProgress?.(60);
      const map = await this.renderMap(browser, template, snapshot, onProgress);
      if (map) assets.set('map', { body: map.image, contentType: 'image/jpeg' });
      const mapRenderedAt = Date.now();
      await onProgress?.(75);

      const page = await browser.newPage({
        viewport: { width: template.PROJECT_PRESENTATION_PAGE_SIZE.width, height: template.PROJECT_PRESENTATION_PAGE_SIZE.height },
      });
      await this.serveAssets(page, template, assets);
      const fontUrls = Object.fromEntries(
        template.PROJECT_PRESENTATION_FONT_FILES.map((file) => [file, `${assetOrigin}/fonts/${file}`]),
      ) as TemplateFontUrls;
      const html = template.renderProjectPresentationHtml(this.createModel(template, snapshot, assets, map), { fontUrls });
      await page.setContent(html, { waitUntil: 'load', timeout: renderTimeoutMs });
      await page.waitForFunction(() => document.documentElement.dataset.ready === 'true', undefined, {
        timeout: renderTimeoutMs,
      });
      await onProgress?.(90);
      const pdf = await page.pdf({
        width: `${template.PROJECT_PRESENTATION_PAGE_SIZE.width}px`,
        height: `${template.PROJECT_PRESENTATION_PAGE_SIZE.height}px`,
        printBackground: true,
        preferCSSPageSize: true,
      });
      await onProgress?.(99);
      const seconds = (from: number, to: number) => ((to - from) / 1000).toFixed(1);
      this.logger.log(
        `Project presentation printed: ${snapshot.objects.length + 4} pages, images ${seconds(startedAt, imagesLoadedAt)}s, `
          + `map ${map ? `${seconds(imagesLoadedAt, mapRenderedAt)}s` : `fallback after ${seconds(imagesLoadedAt, mapRenderedAt)}s`}, `
          + `print ${seconds(mapRenderedAt, Date.now())}s`,
      );
      return Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  private createModel(
    template: ProjectPresentationTemplateModule,
    snapshot: ProjectPresentationSnapshot,
    assets: Map<string, { body: Buffer; contentType: string }>,
    map: ProjectPresentationMapSnapshot | null,
  ): TemplateModel {
    const src = (key: string) => (assets.has(key) ? `${assetOrigin}/assets/${encodeURIComponent(key)}` : null);
    const markers = map?.markers
      ?? template.getProjectPresentationFallbackMarkers(snapshot.objects.map(({ latitude, longitude }) => ({ latitude, longitude })));
    return {
      cover: {
        title: snapshot.cover.title || snapshot.title,
        subtitle: snapshot.cover.subtitle,
        clientName: snapshot.cover.clientName,
        issueLabel: snapshot.cover.issueLabel,
        imageSrc: src('cover'),
      },
      map: {
        title: (snapshot.schemaVersion === 2 && snapshot.map.title) || template.PROJECT_PRESENTATION_DEFAULT_MAP_TITLE,
        imageSrc: src('map'),
        markers,
      },
      projects: snapshot.objects.map((object, index) => ({
        key: object.sourceObjectId,
        title: object.title,
        description: template.truncateProjectPresentationDescription(object.description),
        price: object.price,
        propertyClass: object.propertyClass,
        metro: object.metro,
        advantages: object.advantages,
        imageSrcs: [0, 1, 2].map((slot) => src(`project-${index}-${slot}`)),
      })),
      contacts: {
        phone: snapshot.broker.phone,
        ctaUrl: snapshot.cta.url,
      },
    };
  }

  private async loadImages(snapshot: ProjectPresentationSnapshot, onProgress: Progress) {
    const slots: ImageSlot[] = [];
    if (snapshot.cover.image) slots.push({ key: 'cover', image: snapshot.cover.image, ...imageBoxes.cover });
    snapshot.objects.forEach((object, index) => {
      object.images.slice(0, 3).forEach((image, slot) => {
        slots.push({ key: `project-${index}-${slot}`, image, ...(slot === 0 ? imageBoxes.main : imageBoxes.detail) });
      });
    });

    const assets = new Map<string, { body: Buffer; contentType: string }>();
    let loaded = 0;
    const queue = [...slots];
    const loadNext = async (): Promise<void> => {
      const slot = queue.shift();
      if (!slot) return;
      const body = await this.loadImage(slot);
      if (body) assets.set(slot.key, { body, contentType: 'image/jpeg' });
      loaded += 1;
      await onProgress?.(5 + Math.round((loaded / Math.max(slots.length, 1)) * 50));
      await loadNext();
    };
    await Promise.all(Array.from({ length: imageConcurrency }, () => loadNext()));
    return assets;
  }

  private async loadImage({ image, width, height }: ImageSlot) {
    try {
      const { buffer } = await this.filesService.getContent(image.fileId, 'detail');
      return await sharp(buffer)
        .rotate()
        .resize(width * 2, height * 2, { fit: 'cover', position: 'centre' })
        .flatten({ background: '#ddd9d0' })
        .jpeg({ quality: 86, mozjpeg: true })
        .toBuffer();
    } catch (error) {
      this.logger.warn(`Project presentation image ${image.fileId} is unavailable: ${describeError(error)}`);
      return null;
    }
  }

  private async renderMap(
    browser: Browser,
    template: ProjectPresentationTemplateModule,
    snapshot: ProjectPresentationSnapshot,
    onProgress: Progress,
  ) {
    const config = getProjectPresentationMapConfig();
    if (!config.enabled) return null;
    // The basemap is the slowest step: keep the progress (and the job heartbeat) moving while it renders.
    let progress: number = mapProgress.start;
    const report = async (value: number) => {
      progress = Math.max(progress, value);
      await onProgress?.(progress);
    };
    let pendingTick: Promise<void> = Promise.resolve();
    const ticker = setInterval(() => {
      if (progress >= mapProgress.busyLimit) return;
      pendingTick = pendingTick.then(() => report(progress + 1)).catch(() => undefined);
    }, mapProgressTickMs);
    const points = snapshot.objects.filter(
      (object): object is typeof object & ProjectPresentationMapPoint =>
        typeof object.latitude === 'number' && Number.isFinite(object.latitude)
        && typeof object.longitude === 'number' && Number.isFinite(object.longitude),
    );
    try {
      return await renderProjectPresentationMap(
        browser,
        template,
        points.map(({ latitude, longitude }) => ({ latitude, longitude })),
        config,
        {
          onStage: (stage) => report(mapProgress[stage]),
          onRetry: (error, attempt) => this.logger.warn(
            `Project presentation map attempt ${attempt} failed, retrying: ${describeError(error)}`,
          ),
        },
      );
    } catch (error) {
      // The PDF is still useful without the basemap: markers fall back to a plain background.
      this.logger.warn(`Project presentation map failed: ${describeError(error)}`);
      return null;
    } finally {
      clearInterval(ticker);
      await pendingTick;
    }
  }

  private async serveAssets(
    page: Page,
    template: ProjectPresentationTemplateModule,
    assets: Map<string, { body: Buffer; contentType: string }>,
  ) {
    const fonts = new Map<string, Buffer>(
      template.PROJECT_PRESENTATION_FONT_FILES.map((file) => [file, readFileSync(resolveProjectPresentationFontPath(file))]),
    );
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== assetOrigin) return route.abort();
      const [, kind, rawName = ''] = url.pathname.split('/');
      const name = decodeURIComponent(rawName);
      const font = kind === 'fonts' ? fonts.get(name) : undefined;
      if (font) return route.fulfill({ body: font, contentType: 'font/woff2' });
      const asset = kind === 'assets' ? assets.get(name) : undefined;
      if (asset) return route.fulfill({ body: asset.body, contentType: asset.contentType });
      return route.fulfill({ status: 404, body: '' });
    });
  }
}

export function resolveBrowserExecutablePath(environment: NodeJS.ProcessEnv = process.env) {
  const configured = environment.PROJECT_PRESENTATIONS_BROWSER_EXECUTABLE_PATH?.trim();
  if (configured) return configured;
  return browserCandidates.find((candidate) => existsSync(candidate));
}

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
