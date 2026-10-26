import { z } from 'zod';
import {
  emailSchema,
  localeSchema,
  messageResponse,
  optionalString,
  passwordSchema,
  phoneSchema,
  requiredString,
} from '../../shared/schemas.js';
import { userDtoSchema } from '../users/users.dto.js';

export const registerBody = z.object({
  name: requiredString(100),
  surname: optionalString(100).default(''),
  email: emailSchema,
  password: passwordSchema,
  phone: phoneSchema,
  store_name: requiredString(120),
  store_address: requiredString(250),
  store_phone: phoneSchema,
  locale: localeSchema.default('az'),
});

export const loginBody = z.object({
  email: emailSchema,
  password: z
    .string({ error: 'Email and password are required' })
    .min(1, 'Email and password are required'),
});

export const refreshBody = z.object({
  refresh_token: z.string({ error: 'Refresh token is required' }).min(20).max(200),
});

export const codeBody = z.object({
  code: z
    .string({ error: 'Code is required' })
    .trim()
    .regex(/^\d{6}$/, 'Code must be 6 digits'),
});

export const forgotPasswordBody = z.object({ email: emailSchema });

export const resetPasswordBody = z.object({
  email: emailSchema,
  code: codeBody.shape.code,
  new_password: passwordSchema,
});

export const changePasswordBody = z.object({
  current_password: z
    .string({ error: 'Current password is required' })
    .min(1, 'Current password is required'),
  new_password: passwordSchema,
});

export const sessionSchema = z.object({
  token: z.string().describe('Access token (JWT). Authorization: Bearer <token>'),
  refresh_token: z.string().describe('Opaque refresh token. Store in Keychain.'),
  expires_in: z.number().int().describe('Access token lifetime in seconds'),
});

export const registerResponse = sessionSchema.extend({
  id: z.number().int(),
  name: z.string(),
  email: z.string(),
  phone: z.string(),
  store_name: z.string(),
  store_address: z.string(),
  store_phone: z.string(),
  created_at: z.string(),
  email_verified: z.boolean(),
  user: userDtoSchema,
});

export const loginResponse = sessionSchema.extend({
  message: z.string(),
  user: userDtoSchema,
});

export const changePasswordResponse = sessionSchema.extend({ message: z.string() });

export const verifyEmailResponse = z.object({ message: z.string(), email_verified: z.boolean() });

export { messageResponse };
