import { BASE } from '../config';
import navCopy from '../data/cms/navigation.json';

export const LANGS = ['ko', 'fr'] as const;
export type Lang = (typeof LANGS)[number];

export const langPaths = () => LANGS.map((lang) => ({ params: { lang } }));

/** 같은 페이지의 다른 언어 주소 */
export const altPath = (lang: Lang, rest: string) => `${BASE}${lang === 'ko' ? 'fr' : 'ko'}/${rest}`;
export const href = (lang: Lang, rest = '') => `${BASE}${lang}/${rest}`;

type Dict = Record<string, { ko: string; fr: string }>;

export const ui = {
  'site.name': navCopy.site_name,
  'site.short': navCopy.site_short,
  'nav.about': navCopy.nav_about,
  'nav.section': navCopy.nav_section,
  'nav.admission': navCopy.nav_admission,
  'nav.news': navCopy.nav_news,
  'nav.events': navCopy.nav_events,
  'nav.join': navCopy.nav_join,
  'nav.contact': navCopy.nav_contact,
  'nav.members': navCopy.nav_members,
  'nav.menu': navCopy.nav_menu,
  'nav.skip': navCopy.nav_skip,
  'lang.switch': navCopy.lang_switch,
  'lang.label': navCopy.lang_label,
  'footer.declared': navCopy.footer_declared,
  'footer.legal': navCopy.footer_legal,
  'footer.privacy': navCopy.footer_privacy,
  'footer.statuts': navCopy.footer_statuts,
  'footer.subscribe': navCopy.footer_subscribe,
  'common.more': navCopy.common_more,
  'common.all': navCopy.common_all,
  'common.back': navCopy.common_back,
  'common.placeholder': navCopy.common_placeholder,
} satisfies Dict;

export type UiKey = keyof typeof ui;
export const t = (lang: Lang, key: UiKey) => ui[key][lang];

/** 페이지별 짧은 문구를 한 곳에서 다루기 위한 헬퍼 */
export const L = <T,>(lang: Lang, v: { ko: T; fr: T }) => v[lang];

export type NavItem = { key: UiKey; path: string; children?: { label: { ko: string; fr: string }; path: string }[] };
export const NAV: NavItem[] = [
  { key: 'nav.about', path: 'about/' },
  { key: 'nav.section', path: 'section/', children: navCopy.section_submenu },
  { key: 'nav.admission', path: 'admission/' },
  { key: 'nav.news', path: 'news/' },
  { key: 'nav.events', path: 'events/' },
  { key: 'nav.contact', path: 'contact/' },
];

export const formatDate = (lang: Lang, d: Date | string) => {
  const date = typeof d === 'string' ? new Date(d) : d;
  return lang === 'ko'
    ? `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`
    : date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
};
