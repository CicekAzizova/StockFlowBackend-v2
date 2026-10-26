import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { formatTimestamp } from '../../shared/formatting.js';
import { toUserDto } from '../users/users.dto.js';
import {
  changePasswordBody,
  changePasswordResponse,
  codeBody,
  forgotPasswordBody,
  loginBody,
  loginResponse,
  messageResponse,
  refreshBody,
  registerBody,
  registerResponse,
  resetPasswordBody,
  sessionSchema,
  verifyEmailResponse,
} from './auth.schemas.js';
import { createAuthService } from './auth.service.js';

const secured = [{ bearerAuth: [] }];
const limit = (max: number, timeWindow: string) => ({ rateLimit: { max, timeWindow } });

export const authRoutes: FastifyPluginAsyncZod = async (app) => {
  const { storage } = app.deps;
  const service = createAuthService(app.deps, (payload) => app.jwt.sign(payload), app.log);
  const userAgentOf = (header: string | undefined) => header ?? null;

  app.post(
    '/register',
    {
      config: limit(10, '1 hour'),
      schema: {
        tags: ['Auth'],
        summary: 'Register a store owner and create the first store',
        body: registerBody,
        response: { 201: registerResponse },
      },
    },
    async (request, reply) => {
      const { user, store, session } = await service.register(
        request.body,
        userAgentOf(request.headers['user-agent']),
      );
      return reply.code(201).send({
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        store_name: store.name,
        store_address: store.address,
        store_phone: store.phone,
        created_at: formatTimestamp(user.created_at),
        email_verified: user.email_verified_at !== null,
        user: toUserDto(user, storage),
        ...session,
      });
    },
  );

  app.post(
    '/login',
    {
      config: limit(10, '1 minute'),
      schema: {
        tags: ['Auth'],
        summary: 'Log in with email and password',
        body: loginBody,
        response: { 200: loginResponse },
      },
    },
    async (request) => {
      const { user, session } = await service.login(
        request.body.email,
        request.body.password,
        userAgentOf(request.headers['user-agent']),
      );
      return { message: 'Login successful', user: toUserDto(user, storage), ...session };
    },
  );

  app.post(
    '/refresh',
    {
      config: limit(30, '1 minute'),
      schema: {
        tags: ['Auth'],
        summary: 'Exchange a refresh token for a new access and refresh token',
        description:
          'The old refresh token stops working. Send the new one on the next refresh. ' +
          'A 401 INVALID_REFRESH_TOKEN means the user must log in again.',
        body: refreshBody,
        response: { 200: sessionSchema },
      },
    },
    async (request) =>
      service.refresh(request.body.refresh_token, userAgentOf(request.headers['user-agent'])),
  );

  app.post(
    '/logout',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Revoke the session of a refresh token',
        body: refreshBody,
        response: { 200: messageResponse },
      },
    },
    async (request) => {
      await service.logout(request.body.refresh_token);
      return { message: 'Logged out' };
    },
  );

  app.post(
    '/logout-all',
    {
      onRequest: [app.authenticate],
      config: { allowUnverified: true },
      schema: {
        tags: ['Auth'],
        summary: 'Revoke every session of the current user',
        security: secured,
        response: { 200: messageResponse },
      },
    },
    async (request) => {
      await service.logoutAll(request.auth.userId);
      return { message: 'Logged out from all devices' };
    },
  );

  app.post(
    '/verify-email',
    {
      onRequest: [app.authenticate],
      config: { allowUnverified: true, ...limit(10, '10 minutes') },
      schema: {
        tags: ['Auth'],
        summary: 'Confirm the email address with the 6-digit code',
        description:
          'After success call POST /auth/refresh to receive an access token that carries the verified flag.',
        security: secured,
        body: codeBody,
        response: { 200: verifyEmailResponse },
      },
    },
    async (request) => {
      await service.verifyEmail(request.auth.userId, request.body.code);
      return { message: 'Email verified', email_verified: true };
    },
  );

  app.post(
    '/resend-verification',
    {
      onRequest: [app.authenticate],
      config: { allowUnverified: true, ...limit(5, '10 minutes') },
      schema: {
        tags: ['Auth'],
        summary: 'Send a new verification code',
        security: secured,
        response: { 200: messageResponse },
      },
    },
    async (request) => {
      await service.resendVerification(request.auth.userId);
      return { message: 'Verification code sent' };
    },
  );

  app.post(
    '/forgot-password',
    {
      config: limit(5, '10 minutes'),
      schema: {
        tags: ['Auth'],
        summary: 'Email a password reset code',
        description: 'Always answers 200, whether or not the email is registered.',
        body: forgotPasswordBody,
        response: { 200: messageResponse },
      },
    },
    async (request) => {
      await service.forgotPassword(request.body.email);
      return { message: 'If this email is registered, a reset code has been sent' };
    },
  );

  app.post(
    '/reset-password',
    {
      config: limit(10, '10 minutes'),
      schema: {
        tags: ['Auth'],
        summary: 'Set a new password with the emailed code',
        body: resetPasswordBody,
        response: { 200: messageResponse },
      },
    },
    async (request) => {
      await service.resetPassword(request.body.email, request.body.code, request.body.new_password);
      return { message: 'Password updated. Please log in' };
    },
  );

  app.post(
    '/change-password',
    {
      onRequest: [app.authenticate],
      config: limit(10, '10 minutes'),
      schema: {
        tags: ['Auth'],
        summary: 'Change the password of the signed-in user',
        description: 'All other devices are logged out. The response contains a fresh session.',
        security: secured,
        body: changePasswordBody,
        response: { 200: changePasswordResponse },
      },
    },
    async (request) => {
      const session = await service.changePassword(
        request.auth.userId,
        request.body.current_password,
        request.body.new_password,
        userAgentOf(request.headers['user-agent']),
      );
      return { message: 'Password changed', ...session };
    },
  );
};
