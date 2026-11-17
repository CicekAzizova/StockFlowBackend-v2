import type { FastifyRequest } from 'fastify';
import type { AuthContext } from '../app-types.js';
import type { Queryable } from '../db/pool.js';
import { badRequest, notFound } from './errors.js';
import * as locations from '../modules/locations/locations.repository.js';
import type { LocationRecord } from '../modules/locations/locations.repository.js';

/**
 * Sorğunun işlədiyi məkan. Sahib `X-Location-Id` başlığı ilə seçir, başlıq yoxdursa əsas məkan.
 * Satıcı (Mərhələ 1) həmişə əsas məkanda işləyir.
 */
export async function resolveLocation(
  db: Queryable,
  auth: AuthContext,
  storeId: number,
  header: string | string[] | undefined,
): Promise<LocationRecord> {
  const raw = Array.isArray(header) ? header[0] : header;
  if (auth.role === 'OWNER' && raw !== undefined && raw !== '') {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      throw badRequest('INVALID_LOCATION_ID', 'X-Location-Id must be a positive integer');
    }
    const found = await locations.findLocation(db, storeId, id);
    if (!found) throw notFound('LOCATION_NOT_FOUND', 'Location not found');
    return found;
  }
  const main = (await locations.listLocations(db, storeId)).find((l) => l.is_main);
  if (!main) throw notFound('LOCATION_NOT_FOUND', 'Location not found');
  return main;
}

export const locationHeader = (request: FastifyRequest): string | string[] | undefined =>
  request.headers['x-location-id'];
