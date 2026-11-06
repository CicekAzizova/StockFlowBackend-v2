import { z } from 'zod';
import type { Storage } from '../../infra/storage/storage.js';
import { thumbnailUrlFor } from '../../infra/images.js';
import { formatTimestamp } from '../../shared/formatting.js';
import { localeSchema } from '../../shared/schemas.js';
import type { AssociateRow, UserWithStore } from './users.repository.js';

/** iOS-dakı User və SalesAssociateResponse modelləri bu açarlara güvənir. Silməyin, yalnız əlavə edin. */

export const userDtoSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  surname: z.string(),
  email: z.string(),
  phone: z.string(),
  role: z.enum(['OWNER', 'SALES_ASSOCIATE']),
  fin: z.string().nullable(),
  store_id: z.number().int().nullable(),
  store_name: z.string().nullable(),
  currency: z.string().describe('Store currency (ISO 4217), USD if there is no store'),
  avatar_url: z.string().nullable(),
  avatar_thumbnail_url: z.string().nullable(),
  locale: localeSchema,
  email_verified: z.boolean(),
});

export type UserDto = z.infer<typeof userDtoSchema>;

export function toUserDto(user: UserWithStore, storage: Storage): UserDto {
  return {
    id: user.id,
    name: user.name,
    surname: user.surname,
    email: user.email,
    phone: user.phone,
    role: user.role,
    fin: user.fin,
    store_id: user.effective_store_id,
    store_name: user.store_name,
    currency: user.store_currency ?? 'USD',
    avatar_url: user.avatar_url,
    avatar_thumbnail_url: user.avatar_url ? thumbnailUrlFor(storage, user.avatar_url) : null,
    locale: user.locale,
    email_verified: user.email_verified_at !== null,
  };
}

export const associateDtoSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  surname: z.string(),
  fin: z.string(),
  email: z.string(),
  phone: z.string(),
  role: z.literal('SALES_ASSOCIATE'),
  store_id: z.number().int(),
  avatar_url: z.string().nullable(),
  /** false: sahib deaktiv edib, satıcı daxil ola bilmir. */
  is_active: z.boolean(),
  /** Son 5 dəqiqədə aktiv olubsa true (deaktiv satıcı həmişə false). */
  is_online: z.boolean(),
  /** Son aktivlik, UTC yyyy-MM-dd HH:mm:ss. Heç daxil olmayıbsa null. */
  last_active_at: z.string().nullable(),
  created_at: z.string(),
  today_sales: z.number(),
  today_orders: z.number().int(),
  /** Bu satıcının özünün aylıq satışı və satış sayı. */
  month_sales: z.number(),
  month_orders: z.number().int(),
  total_sales_this_month: z.number(),
});

export type AssociateDto = z.infer<typeof associateDtoSchema>;

const ONLINE_WINDOW_MS = 5 * 60 * 1000;

function isOnline(lastActiveAt: Date | null): boolean {
  return lastActiveAt !== null && Date.now() - lastActiveAt.getTime() < ONLINE_WINDOW_MS;
}

export function toAssociateDto(row: AssociateRow, monthTotal: number): AssociateDto {
  return {
    id: row.id,
    name: row.name,
    surname: row.surname,
    fin: row.fin ?? '',
    email: row.email,
    phone: row.phone,
    role: 'SALES_ASSOCIATE',
    store_id: row.store_id,
    avatar_url: row.avatar_url,
    is_active: row.is_active,
    is_online: row.is_active && isOnline(row.last_active_at),
    last_active_at: row.last_active_at ? formatTimestamp(row.last_active_at) : null,
    created_at: formatTimestamp(row.created_at),
    today_sales: row.today_sales,
    today_orders: row.today_orders,
    month_sales: row.month_sales,
    month_orders: row.month_orders,
    // Köhnə API kimi: bütün mağazanın aylıq cəmi (iOS Team ekranının başlığı bunu göstərir).
    total_sales_this_month: monthTotal,
  };
}
