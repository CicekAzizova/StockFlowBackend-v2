import type { AuthContext } from '../app-types.js';
import { forbidden } from './errors.js';

/** Mağazaya bağlı olmayan istifadəçi məhsul və satışla işləyə bilməz. */
export function requireStoreId(auth: AuthContext): number {
  if (auth.storeId === null) {
    throw forbidden('STORE_NOT_LINKED', 'User is not linked to a store');
  }
  return auth.storeId;
}
