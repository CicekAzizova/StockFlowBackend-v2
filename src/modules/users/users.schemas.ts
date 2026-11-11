import { z } from 'zod';
import {
  emailSchema,
  localeSchema,
  optionalString,
  passwordSchema,
  phoneSchema,
  requiredString,
} from '../../shared/schemas.js';
import { mainCategoriesSchema } from '../catalog/catalog.schemas.js';

const finSchema = z
  .string({ error: 'All fields are required' })
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{5,12}$/, 'FIN must contain 5 to 12 letters or digits');

/** iOS-dakı SalesAssociateRequest: name, surname, fin, phone, email, password. */
export const createAssociateBody = z.object({
  name: requiredString(100),
  surname: requiredString(100),
  fin: finSchema,
  phone: phoneSchema,
  email: emailSchema,
  password: passwordSchema,
  locale: localeSchema.optional(),
});

export const updateAssociateBody = z.object({
  name: requiredString(100).optional(),
  surname: requiredString(100).optional(),
  fin: finSchema.optional(),
  phone: phoneSchema.optional(),
  email: emailSchema.optional(),
  password: passwordSchema.optional().describe('Set a new password for the associate'),
});

export const updateMeBody = z.object({
  name: requiredString(100).optional(),
  surname: optionalString(100).optional(),
  phone: phoneSchema.optional(),
  locale: localeSchema.optional(),
});

export const deleteAccountBody = z.object({
  password: z.string({ error: 'Password is required' }).min(1, 'Password is required'),
});

/** Dəstəklənən valyutalar (ISO 4217). Yeni valyuta əlavə etmək üçün yalnız bu siyahıya yazın. */
export const CURRENCIES = ['AZN', 'USD', 'EUR', 'TRY', 'RUB', 'GBP'] as const;

/** ISO 3166-1 alpha-2 ölkə kodu (AZ, US, TR...). */
export const countrySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Country must be a 2-letter ISO code');

export const updateStoreBody = z.object({
  name: requiredString(120).optional(),
  address: requiredString(250).optional(),
  phone: phoneSchema.optional(),
  currency: z.enum(CURRENCIES, { error: 'Unsupported currency' }).optional(),
  main_categories: mainCategoriesSchema.optional(),
  country: countrySchema.nullable().optional(),
  city: optionalString(100).optional(),
  onboarding_completed: z.boolean().optional(),
});

export const storeDto = z.object({
  id: z.number().int(),
  name: z.string(),
  address: z.string(),
  phone: z.string(),
  timezone: z.string(),
  currency: z.string(),
  main_categories: z.array(z.string()),
  country: z.string().nullable(),
  city: z.string(),
  onboarding_completed: z.boolean(),
});
