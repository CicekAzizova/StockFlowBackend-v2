import { DeleteObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { AppConfig } from '../../config/env.js';

/**
 * Fayl saxlama abstraksiyası. İstehsalda S3 uyğun saxlama (R2, S3, Supabase),
 * testlərdə yaddaş. Server diskə heç nə yazmır.
 */
export interface Storage {
  put(
    key: string,
    body: Buffer,
    options: { contentType: string; cacheControl: string },
  ): Promise<void>;
  delete(keys: string[]): Promise<void>;
  publicUrl(key: string): string;
  /** URL bu saxlamaya aiddirsə açarı (key) qaytarır, deyilsə null. */
  keyFromUrl(url: string): string | null;
}

abstract class BaseStorage implements Storage {
  constructor(protected readonly publicBaseUrl: string) {}

  abstract put(
    key: string,
    body: Buffer,
    options: { contentType: string; cacheControl: string },
  ): Promise<void>;
  abstract delete(keys: string[]): Promise<void>;

  publicUrl(key: string): string {
    return `${this.publicBaseUrl}/${key}`;
  }

  keyFromUrl(url: string): string | null {
    const prefix = `${this.publicBaseUrl}/`;
    return url.startsWith(prefix) ? url.slice(prefix.length) : null;
  }
}

export class S3Storage extends BaseStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(s3: NonNullable<AppConfig['storage']['s3']>, publicBaseUrl: string) {
    super(publicBaseUrl);
    this.bucket = s3.bucket;
    this.client = new S3Client({
      region: s3.region,
      ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
      forcePathStyle: s3.forcePathStyle,
      credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
    });
  }

  async put(
    key: string,
    body: Buffer,
    options: { contentType: string; cacheControl: string },
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: options.contentType,
        CacheControl: options.cacheControl,
      }),
    );
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.client.send(
      new DeleteObjectsCommand({
        Bucket: this.bucket,
        Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
      }),
    );
  }
}

/** Testlər və lokal sınaq üçün. Proses bitəndə məlumat itir. */
export class MemoryStorage extends BaseStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string; cacheControl: string }>();

  async put(
    key: string,
    body: Buffer,
    options: { contentType: string; cacheControl: string },
  ): Promise<void> {
    this.objects.set(key, { body, ...options });
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
  }
}

export function createStorage(config: AppConfig): Storage {
  if (config.storage.driver === 's3' && config.storage.s3) {
    return new S3Storage(config.storage.s3, config.storage.publicBaseUrl);
  }
  return new MemoryStorage(config.storage.publicBaseUrl);
}
