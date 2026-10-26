/**
 * iOS tətbiqi tarixləri "yyyy-MM-dd HH:mm:ss" (UTC) formatında gözləyir
 * (DefaultNetworkService decoder-i). Format dəyişməməlidir.
 */
export function formatTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/** Endirimli qiymət: iOS-dakı ProductsResponse.discountedPrice ilə eyni düstur. */
export function discountedPrice(price: number, discountPercent: number): number {
  return Math.round(price * (100 - discountPercent)) / 100;
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** LIKE sorğusunda xüsusi simvolları (% _ \) adi mətnə çevirir. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}
