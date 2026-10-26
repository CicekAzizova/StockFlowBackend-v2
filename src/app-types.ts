import type pg from 'pg';
import type { AppConfig } from './config/env.js';
import type { Mailer } from './infra/mail/mailer.js';
import type { Storage } from './infra/storage/storage.js';

export type Role = 'OWNER' | 'SALES_ASSOCIATE';

/** Tətbiqin xarici asılılıqları. Testlərdə saxta versiyalarla əvəz olunur. */
export interface AppDeps {
  config: AppConfig;
  pool: pg.Pool;
  storage: Storage;
  mailer: Mailer;
}

/** Hər autentifikasiya olunmuş sorğuda request.auth olaraq mövcuddur. */
export interface AuthContext {
  userId: number;
  role: Role;
  /** Cari mağaza. Sahib üçün ilk mağaza, satıcı üçün öz mağazası. */
  storeId: number | null;
  emailVerified: boolean;
}

export interface AccessTokenPayload {
  sub: string;
  role: Role;
  storeId: number | null;
  /** email təsdiqlənibmi */
  ev: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
    authenticate: (request: FastifyRequest) => Promise<void>;
    requireRole: (...roles: Role[]) => (request: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    auth: AuthContext;
  }
  interface FastifyContextConfig {
    /** true olarsa email təsdiqlənməmiş istifadəçi də bu route-a daxil ola bilər. */
    allowUnverified?: boolean;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    user: AccessTokenPayload;
  }
}
