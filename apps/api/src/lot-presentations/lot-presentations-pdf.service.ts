import { existsSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { Injectable } from '@nestjs/common';
import { FeedUnitStatus, FeedUnitType, File, ObjectImageSection, Prisma } from '@prisma/client';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';

import { FilesService } from '../files/files.service';

const pageWidth = 595.28;
const pageHeight = 841.89;
const marginX = 42;
const contentWidth = pageWidth - marginX * 2;
const regularFontPath = resolveFontPath('NotoSans-Regular.ttf');
const boldFontPath = resolveFontPath('NotoSans-Bold.ttf');

function resolveFontPath(fileName: string) {
  const candidates = [
    join(__dirname, '..', '..', 'assets', 'fonts', fileName),
    join(process.cwd(), 'assets', 'fonts', fileName),
    join(process.cwd(), 'apps', 'api', 'assets', 'fonts', fileName),
  ];
  const resolvedPath = candidates.find((candidate) => existsSync(candidate));

  if (!resolvedPath) {
    throw new Error(`Lot presentation PDF font asset is missing: ${fileName}`);
  }

  return resolvedPath;
}

type PdfPresentationBroker = {
  name: string;
  phone: string;
  email: string;
};

type PdfPresentationObjectImage = {
  id: string;
  sortOrder: number;
  section: ObjectImageSection | null;
  file: File;
};

type PdfPresentationObject = {
  id: string;
  title: string;
  description: string | null;
  address: string | null;
  images: PdfPresentationObjectImage[];
};

export type PdfPresentationUnit = {
  id: string;
  externalId: string;
  type: FeedUnitType;
  status: FeedUnitStatus;
  title: string | null;
  address: string | null;
  building: string | null;
  section: string | null;
  floor: number | null;
  rooms: number | null;
  price: Prisma.Decimal | null;
  discountPrice: Prisma.Decimal | null;
  effectivePrice: Prisma.Decimal | null;
  currency: string | null;
  area: Prisma.Decimal | null;
  pricePerMeter: Prisma.Decimal | null;
  discountPricePerMeter: Prisma.Decimal | null;
  effectivePricePerMeter: Prisma.Decimal | null;
  completionYear: number | null;
  completionQuarter: number | null;
  residentialDetails: {
    apartmentNumber: string | null;
    layoutType: string | null;
    livingArea: Prisma.Decimal | null;
    kitchenArea: Prisma.Decimal | null;
    balconyCount: number | null;
  } | null;
  commercialDetails: {
    commercialType: string | null;
    entrance: string | null;
    ceilingHeight: Prisma.Decimal | null;
    powerKw: Prisma.Decimal | null;
    separateEntrance: boolean | null;
  } | null;
  media: Array<{
    sortOrder: number;
    label: string | null;
    mediaAsset: {
      file: File | null;
    };
  }>;
  object: PdfPresentationObject;
};

export type PdfPresentationGroup = {
  object: PdfPresentationObject;
  units: PdfPresentationUnit[];
};

type GeneratePdfInput = {
  broker: PdfPresentationBroker;
  groups: PdfPresentationGroup[];
  title: string;
};

@Injectable()
export class LotPresentationsPdfService {
  private logoBufferPromise: Promise<Buffer | null> | null = null;

  constructor(private readonly filesService: FilesService) {}

  async generate(input: GeneratePdfInput) {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 0,
      bufferPages: false,
      autoFirstPage: true,
      info: {
        Title: input.title,
        Author: input.broker.name,
        Creator: 'Platforma',
      },
    });
    const chunks: Buffer[] = [];
    const completed = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk: Buffer) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    this.registerFonts(doc);

    let isFirstPage = true;

    for (const group of input.groups) {
      for (const unit of group.units) {
        if (!isFirstPage) {
          doc.addPage();
        }

        isFirstPage = false;
        await this.drawLotPage(doc, unit, input.broker);
      }

      doc.addPage();
      await this.drawProjectPage(doc, group.object, input.broker);
    }

    doc.end();

    return completed;
  }

  private registerFonts(doc: PDFKit.PDFDocument) {
    doc.registerFont('NotoSans', regularFontPath);
    doc.registerFont('NotoSansBold', boldFontPath);
    doc.font('NotoSans');
  }

  private async drawLotPage(doc: PDFKit.PDFDocument, unit: PdfPresentationUnit, broker: PdfPresentationBroker) {
    await this.drawHeader(doc, broker);

    const title = this.getLotTitle(unit);
    const priceSummary = this.getPriceSummary(unit);
    const planFile = unit.media.find((media) => media.mediaAsset.file)?.mediaAsset.file ?? null;

    doc
      .fillColor('#17202a')
      .font('NotoSansBold')
      .fontSize(21)
      .text(title, marginX, 104, { width: contentWidth - 150, lineGap: 2 });

    doc
      .fillColor('#66707c')
      .font('NotoSans')
      .fontSize(9)
      .text([unit.object.title, unit.address].filter(Boolean).join(' / '), marginX, 136, {
        width: contentWidth,
        lineGap: 1,
      });

    this.drawPriceStrip(doc, priceSummary);

    const planY = 238;
    const planHeight = 284;
    doc.roundedRect(marginX, planY, contentWidth, planHeight, 8).fill('#f6f5f1');
    doc.roundedRect(marginX, planY, contentWidth, planHeight, 8).stroke('#d9d4c8');

    if (planFile) {
      const planImage = await this.safeLoadImage(planFile.id, 'detail');

      if (planImage) {
        doc.image(planImage, marginX + 16, planY + 16, {
          fit: [contentWidth - 32, planHeight - 32],
          align: 'center',
          valign: 'center',
        });
      } else {
        this.drawImageFallback(doc, marginX, planY, contentWidth, planHeight, 'Планировка недоступна');
      }
    }

    doc
      .fillColor('#17202a')
      .font('NotoSansBold')
      .fontSize(15)
      .text('О квартире:', marginX, 548);

    this.drawLotFacts(doc, unit, 578);
    this.drawPageMarker(doc);
  }

  private drawPriceStrip(doc: PDFKit.PDFDocument, summary: ReturnType<LotPresentationsPdfService['getPriceSummary']>) {
    const stripY = 162;

    doc.roundedRect(marginX, stripY, contentWidth, 52, 8).fill('#efe9db');
    doc.roundedRect(marginX, stripY, contentWidth, 52, 8).stroke('#d2c6ae');
    doc
      .fillColor('#7b6951')
      .font('NotoSans')
      .fontSize(8)
      .text(summary.label.toUpperCase(), marginX + 18, stripY + 12, { width: 160 });
    doc
      .fillColor('#17202a')
      .font('NotoSansBold')
      .fontSize(18)
      .text(summary.primary, marginX + 18, stripY + 25, { width: 210 });

    if (summary.secondary) {
      doc
        .fillColor('#7b6951')
        .font('NotoSans')
        .fontSize(8)
        .text('Вторая цена', marginX + 256, stripY + 12, { width: 120 });
      doc
        .fillColor('#4c5561')
        .font('NotoSansBold')
        .fontSize(13)
        .text(summary.secondary, marginX + 256, stripY + 28, { width: 150 });
    }

    doc
      .fillColor('#7b6951')
      .font('NotoSans')
      .fontSize(8)
      .text('За м²', marginX + 418, stripY + 12, { width: 70 });
    doc
      .fillColor('#17202a')
      .font('NotoSansBold')
      .fontSize(12)
      .text(summary.pricePerMeter, marginX + 418, stripY + 28, { width: 94 });
  }

  private drawLotFacts(doc: PDFKit.PDFDocument, unit: PdfPresentationUnit, startY: number) {
    const facts = this.getLotFacts(unit);
    const columnGap = 18;
    const columnWidth = (contentWidth - columnGap) / 2;
    const rowHeight = 27;

    facts.forEach((fact, index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = marginX + column * (columnWidth + columnGap);
      const y = startY + row * rowHeight;

      doc
        .moveTo(x, y + rowHeight - 7)
        .lineTo(x + columnWidth, y + rowHeight - 7)
        .strokeColor('#e2ded5')
        .lineWidth(0.5)
        .stroke();
      doc
        .fillColor('#75808c')
        .font('NotoSans')
        .fontSize(7.5)
        .text(fact.label, x, y, { width: 92, continued: false });
      doc
        .fillColor('#17202a')
        .font('NotoSansBold')
        .fontSize(8.2)
        .text(fact.value ?? '', x + 98, y, { width: columnWidth - 98, lineGap: 1 });
    });
  }

  private async drawProjectPage(doc: PDFKit.PDFDocument, object: PdfPresentationObject, broker: PdfPresentationBroker) {
    await this.drawHeader(doc, broker);

    doc
      .fillColor('#17202a')
      .font('NotoSansBold')
      .fontSize(22)
      .text('Описание проекта', marginX, 104, { width: contentWidth });
    doc
      .fillColor('#66707c')
      .font('NotoSans')
      .fontSize(9)
      .text(object.title, marginX, 136, { width: contentWidth });

    const images = this.selectProjectImages(object.images);
    const tileGap = 8;
    const tileWidth = (contentWidth - tileGap * 2) / 3;
    const tileHeight = 102;
    const galleryTop = 164;

    for (const [index, image] of images.entries()) {
      const column = index % 3;
      const row = Math.floor(index / 3);
      const x = marginX + column * (tileWidth + tileGap);
      const y = galleryTop + row * (tileHeight + tileGap);
      const imageBuffer = await this.safeLoadImage(image.file.id, 'detail');

      doc.roundedRect(x, y, tileWidth, tileHeight, 7).fill('#e9e6df');

      if (imageBuffer) {
        doc.image(imageBuffer, x, y, {
          cover: [tileWidth, tileHeight],
          align: 'center',
          valign: 'center',
        });
      } else {
        this.drawImageFallback(doc, x, y, tileWidth, tileHeight, 'Фото недоступно');
      }
    }

    const description = object.description?.trim() || 'Описание проекта пока не заполнено.';

    doc
      .fillColor('#17202a')
      .font('NotoSansBold')
      .fontSize(12)
      .text('Описание и особенности', marginX, 398);

    await this.drawDescriptionText(doc, description, broker, 424);
    this.drawPageMarker(doc);
  }

  private async drawDescriptionText(
    doc: PDFKit.PDFDocument,
    description: string,
    broker: PdfPresentationBroker,
    startY: number,
  ) {
    let cursorY = startY;
    const paragraphs = description
      .split(/\n{2,}/u)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);

    for (const paragraph of paragraphs) {
      const height = doc.heightOfString(paragraph, {
        width: contentWidth,
        lineGap: 3,
      });

      if (cursorY + height > pageHeight - 58) {
        doc.addPage();
        await this.drawHeader(doc, broker);
        doc
          .fillColor('#17202a')
          .font('NotoSansBold')
          .fontSize(18)
          .text('Описание проекта', marginX, 104, { width: contentWidth });
        cursorY = 142;
      }

      doc
        .fillColor('#2d3742')
        .font('NotoSans')
        .fontSize(10)
        .text(paragraph, marginX, cursorY, {
          width: contentWidth,
          lineGap: 3,
        });

      cursorY = doc.y + 12;
    }
  }

  private async drawHeader(doc: PDFKit.PDFDocument, broker: PdfPresentationBroker) {
    const logoBuffer = await this.getLogoBuffer();

    doc.rect(0, 0, pageWidth, 76).fill('#17202a');

    if (logoBuffer) {
      doc.image(logoBuffer, marginX, 22, {
        fit: [66, 28],
        valign: 'center',
      });
    } else {
      doc.fillColor('#ffffff').font('NotoSansBold').fontSize(14).text('FW', marginX, 26, { width: 42 });
    }

    doc
      .fillColor('#ffffff')
      .font('NotoSansBold')
      .fontSize(10)
      .text(broker.name, marginX + 90, 20, { width: 218, lineGap: 1 });
    doc
      .fillColor('#cfd6de')
      .font('NotoSans')
      .fontSize(8)
      .text([broker.phone, broker.email].join(' / '), marginX + 90, 39, { width: 292, lineGap: 1 });
    doc
      .fillColor('#ffffff')
      .font('NotoSansBold')
      .fontSize(8)
      .text('PDF-презентация лота', pageWidth - marginX - 150, 30, {
        width: 150,
        align: 'right',
      });
  }

  private drawPageMarker(doc: PDFKit.PDFDocument) {
    doc
      .fillColor('#98a1ad')
      .font('NotoSans')
      .fontSize(7)
      .text('Platforma', marginX, pageHeight - 30, { width: contentWidth, align: 'right' });
  }

  private drawImageFallback(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    width: number,
    height: number,
    label: string,
  ) {
    doc
      .fillColor('#8a949f')
      .font('NotoSans')
      .fontSize(9)
      .text(label, x, y + height / 2 - 6, { width, align: 'center' });
  }

  private selectProjectImages(images: PdfPresentationObjectImage[]) {
    const selected = new Map<string, PdfPresentationObjectImage>();
    const sections: ObjectImageSection[] = [
      ObjectImageSection.ARCHITECTURE,
      ObjectImageSection.INTERIORS,
      ObjectImageSection.FILLING,
    ];

    for (const section of sections) {
      for (const image of images.filter((item) => item.section === section).slice(0, 2)) {
        selected.set(image.id, image);
      }
    }

    for (const image of images) {
      if (selected.size >= 6) {
        break;
      }

      selected.set(image.id, image);
    }

    return [...selected.values()].slice(0, 6);
  }

  private getPriceSummary(unit: PdfPresentationUnit) {
    const hasDiscount = this.hasRealDiscount(unit);
    const primary = hasDiscount
      ? this.formatMoney(unit.discountPrice, unit.currency)
      : this.formatMoney(unit.price ?? unit.effectivePrice, unit.currency);
    const secondary = hasDiscount ? this.formatMoney(unit.price, unit.currency) : null;
    const pricePerMeter = hasDiscount && unit.discountPricePerMeter
      ? this.formatMoney(unit.discountPricePerMeter, unit.currency)
      : this.formatPricePerMeter(unit);

    return {
      label: hasDiscount ? 'Цена со скидкой' : 'Цена',
      primary,
      secondary,
      pricePerMeter,
    };
  }

  private getLotFacts(unit: PdfPresentationUnit) {
    const facts: Array<{ label: string; value: string | null }> = [
      { label: 'Цена', value: this.formatMoney(unit.price, unit.currency) },
      this.hasRealDiscount(unit)
        ? { label: 'Цена со скидкой', value: this.formatMoney(unit.discountPrice, unit.currency) }
        : { label: 'Цена со скидкой', value: null },
      { label: 'Цена за м²', value: this.formatPricePerMeter(unit) },
      this.hasRealDiscount(unit)
        ? { label: 'Цена за м² без скидки', value: this.formatMoney(unit.pricePerMeter, unit.currency) }
        : { label: 'Цена за м² без скидки', value: null },
      { label: 'Площадь', value: this.formatArea(unit.area) },
      { label: 'Комнаты / тип', value: this.getUnitRoomsOrType(unit) },
      { label: 'Корпус', value: this.formatOptional(unit.building) },
      { label: 'Секция', value: this.formatOptional(unit.section) },
      { label: 'Этаж', value: unit.floor === null ? null : String(unit.floor) },
      { label: 'Номер квартиры', value: unit.residentialDetails?.apartmentNumber ?? unit.title ?? unit.externalId },
      { label: 'Планировка', value: unit.residentialDetails?.layoutType ?? null },
      { label: 'Жилая площадь', value: this.formatArea(unit.residentialDetails?.livingArea ?? null) },
      { label: 'Кухня', value: this.formatArea(unit.residentialDetails?.kitchenArea ?? null) },
      { label: 'Балконы', value: unit.residentialDetails?.balconyCount === null || unit.residentialDetails?.balconyCount === undefined ? null : String(unit.residentialDetails.balconyCount) },
      { label: 'Срок сдачи', value: this.formatCompletion(unit) },
      { label: 'Статус', value: this.formatStatus(unit.status) },
      { label: 'Адрес', value: unit.address ?? unit.object.address },
      { label: 'ID лота', value: unit.externalId },
      { label: 'Коммерческий тип', value: unit.commercialDetails?.commercialType ?? null },
      { label: 'Вход', value: unit.commercialDetails?.entrance ?? null },
      { label: 'Потолки', value: this.formatMeters(unit.commercialDetails?.ceilingHeight ?? null) },
      { label: 'Мощность', value: this.formatPower(unit.commercialDetails?.powerKw ?? null) },
      {
        label: 'Отдельный вход',
        value: unit.commercialDetails?.separateEntrance === null || unit.commercialDetails?.separateEntrance === undefined
          ? null
          : unit.commercialDetails.separateEntrance
            ? 'Да'
            : 'Нет',
      },
    ];

    return facts.filter((fact) => fact.value && fact.value !== 'Не указано');
  }

  private getLotTitle(unit: PdfPresentationUnit) {
    return unit.title?.trim() || unit.residentialDetails?.apartmentNumber || `Лот ${unit.externalId}`;
  }

  private getUnitRoomsOrType(unit: PdfPresentationUnit) {
    if (unit.type === FeedUnitType.RESIDENTIAL) {
      if (unit.rooms === 0) {
        return 'Студия';
      }

      if (unit.rooms) {
        return `${unit.rooms}-комн.`;
      }

      return unit.residentialDetails?.layoutType ?? 'Жилой';
    }

    return unit.commercialDetails?.commercialType ?? 'Коммерческий';
  }

  private formatPricePerMeter(unit: PdfPresentationUnit) {
    const value = unit.effectivePricePerMeter ?? unit.discountPricePerMeter ?? unit.pricePerMeter;

    if (value) {
      return `${this.formatMoney(value, unit.currency)}/м²`;
    }

    const price = unit.effectivePrice ?? unit.discountPrice ?? unit.price;
    const area = this.decimalToNumber(unit.area);
    const priceValue = this.decimalToNumber(price);

    if (priceValue !== null && area !== null && area > 0) {
      return `${this.formatNumber(priceValue / area)} ₽/м²`;
    }

    return 'По запросу';
  }

  private formatMoney(value: Prisma.Decimal | null | undefined, currency: string | null) {
    const numberValue = this.decimalToNumber(value ?? null);

    if (numberValue === null) {
      return 'По запросу';
    }

    if (currency && !['RUB', 'RUR'].includes(currency.toUpperCase())) {
      return `${this.formatNumber(numberValue)} ${currency}`;
    }

    return `${this.formatNumber(numberValue)} ₽`;
  }

  private formatArea(value: Prisma.Decimal | null) {
    const numberValue = this.decimalToNumber(value);

    return numberValue === null ? null : `${this.formatNumber(numberValue)} м²`;
  }

  private formatMeters(value: Prisma.Decimal | null) {
    const numberValue = this.decimalToNumber(value);

    return numberValue === null ? null : `${this.formatNumber(numberValue)} м`;
  }

  private formatPower(value: Prisma.Decimal | null) {
    const numberValue = this.decimalToNumber(value);

    return numberValue === null ? null : `${this.formatNumber(numberValue)} кВт`;
  }

  private formatCompletion(unit: PdfPresentationUnit) {
    if (!unit.completionYear) {
      return null;
    }

    return unit.completionQuarter ? `${unit.completionQuarter} кв. ${unit.completionYear}` : String(unit.completionYear);
  }

  private formatStatus(status: FeedUnitStatus) {
    const labels: Record<FeedUnitStatus, string> = {
      AVAILABLE: 'Доступен',
      BOOKED: 'Забронирован',
      RESERVED: 'Резерв',
      SOLD: 'Продан',
      ARCHIVED: 'Архив',
      UNKNOWN: 'Неизвестно',
    };

    return labels[status];
  }

  private formatOptional(value: string | null) {
    return value?.trim() || null;
  }

  private hasRealDiscount(unit: PdfPresentationUnit) {
    const price = this.decimalToNumber(unit.price);
    const discountPrice = this.decimalToNumber(unit.discountPrice);

    return price !== null && discountPrice !== null && discountPrice > 0 && discountPrice < price;
  }

  private decimalToNumber(value: Prisma.Decimal | null | undefined) {
    if (!value) {
      return null;
    }

    const parsed = Number(value.toString());

    return Number.isFinite(parsed) ? parsed : null;
  }

  private formatNumber(value: number) {
    return new Intl.NumberFormat('ru-RU', {
      maximumFractionDigits: Number.isInteger(value) ? 0 : 1,
    }).format(value);
  }

  private async safeLoadImage(fileId: string, variant: 'detail' | 'card' | 'thumbnail') {
    try {
      const { buffer } = await this.filesService.getContent(fileId, variant);

      return sharp(buffer)
        .rotate()
        .jpeg({
          quality: 88,
          mozjpeg: true,
        })
        .toBuffer();
    } catch {
      return null;
    }
  }

  private async getLogoBuffer() {
    if (!this.logoBufferPromise) {
      this.logoBufferPromise = this.loadLogoBuffer();
    }

    return this.logoBufferPromise;
  }

  private async loadLogoBuffer() {
    const candidates = [
      join(process.cwd(), '_Fluffy_White_1-02.svg'),
      join(process.cwd(), '..', '_Fluffy_White_1-02.svg'),
      join(process.cwd(), '..', '..', '_Fluffy_White_1-02.svg'),
    ];

    for (const candidate of candidates) {
      if (await this.pathExists(candidate)) {
        const svg = await readFile(candidate);

        return sharp(svg)
          .resize({
            width: 150,
            withoutEnlargement: true,
          })
          .png()
          .toBuffer();
      }
    }

    return null;
  }

  private async pathExists(path: string) {
    return access(path)
      .then(() => true)
      .catch(() => false);
  }
}
