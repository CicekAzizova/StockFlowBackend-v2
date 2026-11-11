/**
 * Mağaza və məhsul kateqoriyaları kataloqu.
 * Kodlar sabitdir (verilənlər bazasında saxlanılır), adlar dörd dildə təqdim olunur.
 * Yeni alt kateqoriya əlavə etmək üçün yalnız bu fayla yazmaq kifayətdir.
 * Alt kateqoriya kodu `<əsas>.<alt>` formasındadır, məsələn `food.dairy`.
 */

export const MAIN_CATEGORY_CODES = [
  'food',
  'clothing',
  'footwear_bags',
  'electronics',
  'home',
  'beauty',
  'kids',
  'books',
  'auto',
  'construction',
  'sports',
  'other',
] as const;

export type MainCategoryCode = (typeof MAIN_CATEGORY_CODES)[number];

export interface Names {
  en: string;
  az: string;
  ru: string;
  tr: string;
}

export interface CatalogSubcategory {
  code: string;
  names: Names;
}

export interface CatalogCategory {
  code: MainCategoryCode;
  names: Names;
  subcategories: CatalogSubcategory[];
}

const n = (en: string, az: string, ru: string, tr: string): Names => ({ en, az, ru, tr });

const OTHER = n('Other', 'Digər', 'Другое', 'Diğer');

type SubInput = [code: string, names: Names];

/** Hər əsas kateqoriyanın sonuna avtomatik "Digər" əlavə olunur. */
function category(code: MainCategoryCode, names: Names, subs: SubInput[]): CatalogCategory {
  return {
    code,
    names,
    subcategories: [...subs, ['other', OTHER] as SubInput].map(([sub, subNames]) => ({
      code: `${code}.${sub}`,
      names: subNames,
    })),
  };
}

export const CATALOG: CatalogCategory[] = [
  category('food', n('Food', 'Ərzaq', 'Продукты', 'Gıda'), [
    ['dairy', n('Dairy', 'Süd məhsulları', 'Молочные продукты', 'Süt ürünleri')],
    [
      'bakery',
      n('Bakery and sweets', 'Çörək və şirniyyat', 'Хлеб и сладости', 'Fırın ve tatlılar'),
    ],
    ['meat_fish', n('Meat and fish', 'Ət və balıq', 'Мясо и рыба', 'Et ve balık')],
    ['produce', n('Fruits and vegetables', 'Meyvə və tərəvəz', 'Фрукты и овощи', 'Meyve ve sebze')],
    ['grocery', n('Dry goods', 'Quru ərzaq', 'Бакалея', 'Kuru gıda')],
    ['canned', n('Canned food', 'Konserv', 'Консервы', 'Konserve')],
    ['drinks', n('Drinks', 'İçkilər', 'Напитки', 'İçecekler')],
    ['snacks', n('Snacks', 'Qəlyanaltılar', 'Снеки', 'Atıştırmalıklar')],
  ]),
  category('clothing', n('Clothing', 'Geyim', 'Одежда', 'Giyim'), [
    ['men', n("Men's clothing", 'Kişi geyimi', 'Мужская одежда', 'Erkek giyim')],
    ['women', n("Women's clothing", 'Qadın geyimi', 'Женская одежда', 'Kadın giyim')],
    ['kids', n("Kids' clothing", 'Uşaq geyimi', 'Детская одежда', 'Çocuk giyim')],
    [
      'underwear',
      n('Underwear and socks', 'Alt paltarı və corab', 'Нижнее бельё и носки', 'İç giyim ve çorap'),
    ],
    ['outerwear', n('Outerwear', 'Üst geyim', 'Верхняя одежда', 'Dış giyim')],
    ['sportswear', n('Sportswear', 'İdman geyimi', 'Спортивная одежда', 'Spor giyim')],
  ]),
  category(
    'footwear_bags',
    n(
      'Shoes, bags and accessories',
      'Ayaqqabı, çanta və aksesuarlar',
      'Обувь, сумки и аксессуары',
      'Ayakkabı, çanta ve aksesuar',
    ),
    [
      ['shoes_men', n("Men's shoes", 'Kişi ayaqqabısı', 'Мужская обувь', 'Erkek ayakkabı')],
      ['shoes_women', n("Women's shoes", 'Qadın ayaqqabısı', 'Женская обувь', 'Kadın ayakkabı')],
      ['shoes_kids', n("Kids' shoes", 'Uşaq ayaqqabısı', 'Детская обувь', 'Çocuk ayakkabı')],
      ['bags', n('Bags', 'Çantalar', 'Сумки', 'Çantalar')],
      ['accessories', n('Accessories', 'Aksesuarlar', 'Аксессуары', 'Aksesuarlar')],
      [
        'watches_jewelry',
        n('Watches and jewelry', 'Saat və zinət əşyaları', 'Часы и украшения', 'Saat ve takı'),
      ],
    ],
  ),
  category('electronics', n('Electronics', 'Elektronika', 'Электроника', 'Elektronik'), [
    ['phones', n('Phones', 'Telefonlar', 'Телефоны', 'Telefonlar')],
    [
      'computers',
      n(
        'Computers and tablets',
        'Kompüter və planşetlər',
        'Компьютеры и планшеты',
        'Bilgisayar ve tabletler',
      ),
    ],
    ['audio', n('Headphones and audio', 'Qulaqlıq və səs', 'Наушники и аудио', 'Kulaklık ve ses')],
    ['appliances', n('Home appliances', 'Məişət texnikası', 'Бытовая техника', 'Ev aletleri')],
    ['tv', n('TV and video', 'Televizor və video', 'Телевизоры и видео', 'TV ve video')],
    [
      'accessories',
      n(
        'Cables and accessories',
        'Kabel və aksesuarlar',
        'Кабели и аксессуары',
        'Kablo ve aksesuarlar',
      ),
    ],
  ]),
  category('home', n('Home and household', 'Ev və məişət', 'Дом и быт', 'Ev ve yaşam'), [
    ['kitchen', n('Kitchenware', 'Mətbəx qabları', 'Кухонная посуда', 'Mutfak gereçleri')],
    [
      'cleaning',
      n(
        'Cleaning and chemicals',
        'Təmizlik və məişət kimyası',
        'Уборка и бытовая химия',
        'Temizlik ve deterjan',
      ),
    ],
    ['textile', n('Home textile', 'Ev tekstili', 'Домашний текстиль', 'Ev tekstili')],
    ['furniture', n('Furniture', 'Mebel', 'Мебель', 'Mobilya')],
    ['decor', n('Decor', 'Dekor', 'Декор', 'Dekorasyon')],
    ['lighting', n('Lighting', 'İşıqlandırma', 'Освещение', 'Aydınlatma')],
  ]),
  category(
    'beauty',
    n('Beauty and care', 'Gözəllik və baxım', 'Красота и уход', 'Güzellik ve bakım'),
    [
      ['cosmetics', n('Cosmetics', 'Kosmetika', 'Косметика', 'Kozmetik')],
      ['skincare', n('Skin care', 'Dəri baxımı', 'Уход за кожей', 'Cilt bakımı')],
      ['hair', n('Hair care', 'Saç baxımı', 'Уход за волосами', 'Saç bakımı')],
      ['perfume', n('Perfume', 'Ətir', 'Парфюмерия', 'Parfüm')],
      ['hygiene', n('Hygiene', 'Gigiyena', 'Гигиена', 'Hijyen')],
    ],
  ),
  category('kids', n('Kids and toys', 'Uşaq və oyuncaq', 'Детям и игрушки', 'Çocuk ve oyuncak'), [
    ['toys', n('Toys', 'Oyuncaqlar', 'Игрушки', 'Oyuncaklar')],
    ['baby_care', n('Baby care', 'Körpə baxımı', 'Уход за малышом', 'Bebek bakımı')],
    ['baby_food', n('Baby food', 'Körpə qidası', 'Детское питание', 'Bebek maması')],
    [
      'strollers',
      n(
        'Strollers and car seats',
        'Uşaq arabası və oturacaqlar',
        'Коляски и автокресла',
        'Bebek arabası ve koltuklar',
      ),
    ],
    ['school', n('School supplies', 'Məktəb ləvazimatları', 'Школьные товары', 'Okul malzemeleri')],
  ]),
  category(
    'books',
    n('Books and notebooks', 'Kitab və dəftər', 'Книги и тетради', 'Kitap ve defter'),
    [
      ['books', n('Books', 'Kitablar', 'Книги', 'Kitaplar')],
      ['notebooks', n('Notebooks', 'Dəftərlər', 'Тетради', 'Defterler')],
      [
        'pens',
        n(
          'Pens and writing supplies',
          'Qələm və yazı ləvazimatı',
          'Ручки и письменные принадлежности',
          'Kalem ve yazı gereçleri',
        ),
      ],
      [
        'office',
        n('Office supplies', 'Ofis ləvazimatı', 'Канцелярия для офиса', 'Ofis malzemeleri'),
      ],
      ['art', n('Art and craft', 'Rəsm və yaradıcılıq', 'Рисование и творчество', 'Resim ve hobi')],
    ],
  ),
  category('auto', n('Auto', 'Avtomobil', 'Авто', 'Otomotiv'), [
    ['parts', n('Spare parts', 'Ehtiyat hissələri', 'Запчасти', 'Yedek parça')],
    ['oils', n('Oils and fluids', 'Yağlar və mayelər', 'Масла и жидкости', 'Yağlar ve sıvılar')],
    ['tires', n('Tires and wheels', 'Təkərlər və disklər', 'Шины и диски', 'Lastik ve jant')],
    [
      'accessories',
      n('Car accessories', 'Avtomobil aksesuarları', 'Автоаксессуары', 'Oto aksesuar'),
    ],
    ['care', n('Car care', 'Avtomobil baxımı', 'Автокосметика', 'Oto bakım')],
  ]),
  category(
    'construction',
    n('Construction and repair', 'Tikinti və təmir', 'Строительство и ремонт', 'İnşaat ve tadilat'),
    [
      ['tools', n('Tools', 'Alətlər', 'Инструменты', 'El aletleri')],
      ['paint', n('Paint and finishing', 'Boya və pardaq', 'Краски и отделка', 'Boya ve kaplama')],
      ['plumbing', n('Plumbing', 'Santexnika', 'Сантехника', 'Tesisat')],
      ['electrical', n('Electrical', 'Elektrik', 'Электрика', 'Elektrik malzemeleri')],
      [
        'hardware',
        n('Fasteners and hardware', 'Bərkidici və furnitur', 'Крепёж и фурнитура', 'Hırdavat'),
      ],
    ],
  ),
  category('sports', n('Sports', 'İdman', 'Спорт', 'Spor'), [
    ['equipment', n('Equipment', 'İdman avadanlığı', 'Спортинвентарь', 'Spor ekipmanı')],
    ['fitness', n('Fitness', 'Fitnes', 'Фитнес', 'Fitness')],
    ['nutrition', n('Sports nutrition', 'İdman qidası', 'Спортпит', 'Sporcu besini')],
    [
      'outdoor',
      n('Outdoor and camping', 'Turizm və düşərgə', 'Туризм и кемпинг', 'Kamp ve outdoor'),
    ],
    [
      'bikes',
      n(
        'Bikes and scooters',
        'Velosiped və skuter',
        'Велосипеды и самокаты',
        'Bisiklet ve scooter',
      ),
    ],
  ]),
  // "Digər" əsas kateqoriyasının yalnız bir alt kateqoriyası var (avtomatik əlavə olunan "Digər").
  category('other', OTHER, []),
];

const SUBCATEGORY_CODES = new Set(CATALOG.flatMap((c) => c.subcategories.map((s) => s.code)));

/** Alt kateqoriya mövcuddur və verilən əsas kateqoriyalardan birinə aiddir? */
export function isSubcategoryOfAny(subcategory: string, mainCategories: string[]): boolean {
  if (!SUBCATEGORY_CODES.has(subcategory)) return false;
  const main = subcategory.split('.')[0] ?? '';
  return mainCategories.includes(main);
}
