import { randomBytes } from 'node:crypto';
import { badRequest } from '../../shared/errors.js';
import { isSubcategoryOfAny, type MainCategoryCode } from '../catalog/catalog.data.js';

/** Mağazanın öz alt kateqoriyası. Kod sabitdir, ad dəyişə bilər. */
export interface CustomSubcategory {
  code: string;
  main: MainCategoryCode;
  name: string;
}

export interface CustomSubcategoryInput {
  code?: string | undefined;
  main: MainCategoryCode;
  name: string;
}

/** Alt kateqoriya kataloqdandır və ya mağazanın özünündür, həm də seçilmiş əsas kateqoriyalara aiddir? */
export function isAllowedSubcategory(
  code: string,
  mainCategories: string[],
  customs: CustomSubcategory[],
): boolean {
  if (isSubcategoryOfAny(code, mainCategories)) return true;
  return customs.some((item) => item.code === code && mainCategories.includes(item.main));
}

/**
 * Müştərinin göndərdiyi tam siyahını yoxlayır: kodu olanlar mövcud olmalıdır, kodsuzlara yeni kod verilir.
 * Eyni əsas kateqoriyada eyni ad təkrarlana bilməz (böyük/kiçik hərf fərqi nəzərə alınmır).
 */
export function resolveCustomSubcategories(
  input: CustomSubcategoryInput[],
  current: CustomSubcategory[],
  mainCategories: string[],
): { items: CustomSubcategory[]; created: string[] } {
  const items: CustomSubcategory[] = [];
  const created: string[] = [];
  const seenNames = new Set<string>();
  const seenCodes = new Set<string>();

  for (const entry of input) {
    if (!mainCategories.includes(entry.main)) {
      throw badRequest(
        'INVALID_SUBCATEGORY',
        'Custom subcategory does not belong to the categories of this store',
      );
    }
    const nameKey = `${entry.main}:${entry.name.toLowerCase()}`;
    if (seenNames.has(nameKey)) {
      throw badRequest('DUPLICATE_SUBCATEGORY', 'Subcategory name is already used');
    }
    seenNames.add(nameKey);

    let code = entry.code;
    if (code !== undefined) {
      const existing = current.find((item) => item.code === code);
      if (!existing || existing.main !== entry.main || seenCodes.has(code)) {
        throw badRequest('INVALID_SUBCATEGORY', 'Unknown custom subcategory');
      }
    } else {
      code = `${entry.main}.c_${randomBytes(4).toString('hex')}`;
      created.push(code);
    }
    seenCodes.add(code);
    items.push({ code, main: entry.main, name: entry.name });
  }
  return { items, created };
}
