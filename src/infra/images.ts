import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { badRequest } from '../shared/errors.js';
import type { Storage } from './storage/storage.js';

/**
 * Yüklənən şəkli yoxlayır, kiçildir və iki variantda saxlayır:
 *  - əsas şəkil (siyahı olmayan ekranlar üçün)
 *  - thumbnail (siyahılar üçün, trafik və yaddaşa qənaət)
 * Faylın növü uzantıya görə yox, içindəki məlumata görə müəyyən edilir.
 * EXIF (GPS daxil) silinir, şəkil düzgün istiqamətə çevrilir.
 */

export type ImageKind = 'product' | 'avatar';

const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);
const MAX_INPUT_PIXELS = 40_000_000;
const CACHE_CONTROL = 'public, max-age=31536000, immutable';

const VARIANTS: Record<ImageKind, { main: number; thumb: number; fit: 'inside' | 'cover' }> = {
  product: { main: 1600, thumb: 320, fit: 'inside' },
  avatar: { main: 512, thumb: 128, fit: 'cover' },
};

export interface StoredImage {
  url: string;
  thumbnailUrl: string;
  keys: string[];
}

async function render(input: Buffer, size: number, fit: 'inside' | 'cover'): Promise<Buffer> {
  return sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
    .rotate()
    .resize({ width: size, height: size, fit, withoutEnlargement: fit === 'inside' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();
}

export async function saveImage(
  storage: Storage,
  input: Buffer,
  kind: ImageKind,
  folder: string,
): Promise<StoredImage> {
  let format: string | undefined;
  try {
    format = (await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()).format;
  } catch {
    throw badRequest('INVALID_IMAGE', 'The uploaded file is not a valid image');
  }
  if (!format || !ALLOWED_FORMATS.has(format)) {
    throw badRequest('INVALID_IMAGE', 'Only JPEG, PNG or WebP images are allowed');
  }

  const variant = VARIANTS[kind];
  let main: Buffer;
  let thumb: Buffer;
  try {
    [main, thumb] = await Promise.all([
      render(input, variant.main, variant.fit),
      render(input, variant.thumb, variant.fit),
    ]);
  } catch {
    throw badRequest('INVALID_IMAGE', 'The uploaded file is not a valid image');
  }

  const base = `${folder}/${randomUUID()}`;
  const mainKey = `${base}.jpg`;
  const thumbKey = `${base}_t.jpg`;
  const options = { contentType: 'image/jpeg', cacheControl: CACHE_CONTROL };
  await Promise.all([storage.put(mainKey, main, options), storage.put(thumbKey, thumb, options)]);

  return {
    url: storage.publicUrl(mainKey),
    thumbnailUrl: storage.publicUrl(thumbKey),
    keys: [mainKey, thumbKey],
  };
}

/** Əsas şəklin URL-indən thumbnail URL-ni çıxarır (adlandırma qaydası: <ad>.jpg və <ad>_t.jpg). */
export function thumbnailUrlFor(storage: Storage, url: string): string {
  if (storage.keyFromUrl(url) === null || !url.endsWith('.jpg') || url.endsWith('_t.jpg')) {
    return url;
  }
  return `${url.slice(0, -'.jpg'.length)}_t.jpg`;
}

/** Saxlamadakı bütün variantların açarlarını qaytarır (silmək üçün). */
export function keysForUrl(storage: Storage, url: string): string[] {
  const key = storage.keyFromUrl(url);
  if (key === null || !key.endsWith('.jpg')) return [];
  return key.endsWith('_t.jpg') ? [key] : [key, `${key.slice(0, -'.jpg'.length)}_t.jpg`];
}
