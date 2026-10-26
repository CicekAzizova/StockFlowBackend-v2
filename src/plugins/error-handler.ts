import type { FastifyInstance } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { AppError } from '../shared/errors.js';

interface ErrorBody {
  message: string;
  code: string;
  details?: unknown;
  request_id?: string;
}

/** Fastify-ın öz xətalarını (JSON səhv, böyük fayl və s.) bizim formata çevirir. */
const FASTIFY_ERROR_CODES: Record<string, { status: number; code: string; message: string }> = {
  FST_ERR_CTP_INVALID_JSON_BODY: {
    status: 400,
    code: 'INVALID_JSON',
    message: 'Request body is not valid JSON',
  },
  FST_ERR_CTP_EMPTY_JSON_BODY: {
    status: 400,
    code: 'INVALID_JSON',
    message: 'Request body is empty',
  },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: {
    status: 415,
    code: 'UNSUPPORTED_MEDIA_TYPE',
    message: 'Unsupported content type',
  },
  FST_ERR_CTP_BODY_TOO_LARGE: {
    status: 413,
    code: 'PAYLOAD_TOO_LARGE',
    message: 'Request body is too large',
  },
  FST_REQ_FILE_TOO_LARGE: {
    status: 413,
    code: 'IMAGE_TOO_LARGE',
    message: 'Image is too large (max 5 MB)',
  },
  FST_FILES_LIMIT: { status: 400, code: 'TOO_MANY_FILES', message: 'Only one file is allowed' },
};

export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_request, reply) => {
    const body: ErrorBody = { message: 'Route not found', code: 'ROUTE_NOT_FOUND' };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      const body: ErrorBody = { message: error.message, code: error.code };
      if (error.details !== undefined) body.details = error.details;
      return reply.code(error.statusCode).send(body);
    }

    if (hasZodFastifySchemaValidationErrors(error)) {
      const details = error.validation.map((issue) => ({
        field: issue.instancePath.replace(/^\//, '').replaceAll('/', '.'),
        message: issue.message ?? 'Invalid value',
      }));
      const body: ErrorBody = {
        message: details[0]?.message ?? 'Validation failed',
        code: 'VALIDATION_ERROR',
        details,
      };
      return reply.code(400).send(body);
    }

    const code = (error as { code?: string }).code;
    const known = code ? FASTIFY_ERROR_CODES[code] : undefined;
    if (known) {
      return reply
        .code(known.status)
        .send({ message: known.message, code: known.code } satisfies ErrorBody);
    }

    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply.code(429).send({
        message: 'Too many requests, please slow down',
        code: 'RATE_LIMITED',
      } satisfies ErrorBody);
    }

    if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'Response does not match its schema');
    } else {
      request.log.error({ err: error }, 'Unhandled error');
    }
    return reply.code(500).send({
      message: 'Something went wrong',
      code: 'INTERNAL_ERROR',
      request_id: request.id,
    } satisfies ErrorBody);
  });
}
