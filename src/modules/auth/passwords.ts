import { hash, verify } from '@node-rs/argon2';

/**
 * Parol hash-ləmə: Argon2id (OWASP tövsiyəsi, kitabxananın default parametrləri).
 * İş ayrı thread-də gedir, ona görə Node.js event loop-u bloklamır.
 */

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // Zədələnmiş və ya deaktiv edilmiş hash həmişə uyğunsuzluq sayılır.
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * İstifadəçi tapılmayanda da eyni vaxt sərf olunsun deyə saxta hash ilə yoxlama aparılır.
 * Beləliklə cavab müddətinə baxaraq hansı emaillərin qeydiyyatda olduğunu bilmək olmur.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword('stockflow-timing-equalizer');
  await verifyPassword(await dummyHash, password);
}
