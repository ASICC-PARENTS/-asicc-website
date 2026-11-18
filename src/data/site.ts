// ASICC: CMS 편집 데이터의 집계 파일. 문구 수정은 Pages CMS에서 합니다.
import cmsEvents from './events.json';
import cmsCopy from './site-copy.json';
import schools from './cms/schools.json';
import association from './cms/association.json';
import admissions from './cms/admissions.json';
import annual from './cms/annual.json';

type T = { ko: string; fr: string };
export type LevelId = 'mat' | 'elem' | 'col';
export const NEXT_YEAR = schools.NEXT_YEAR;
export const STATS = schools.STATS;
export const LEVELS = schools.LEVELS;
export const GRADES = schools.GRADES;
export const BUREAU = association.BUREAU;
export const AXES = association.AXES;
export const HISTORY = association.HISTORY;
export const PARTNERS = association.PARTNERS;
export const PROFILES = admissions.PROFILES;
export const EXPECTED = admissions.EXPECTED;
export const CAMPAIGN = admissions.CAMPAIGN;
export const WAVE2 = admissions.WAVE2;
export const ADMISSION_NOTES = admissions.ADMISSION_NOTES;
export const ADMISSION_CONTACTS = admissions.ADMISSION_CONTACTS;
export const ANNUAL = annual.ANNUAL;
export const GRADES_TABLE = schools.GRADES;
// 공식 메일이 CMS에서 바뀌면 FAQ에도 반영합니다.
export const FAQ = admissions.FAQ.map((entry) => ({
  q: entry.q,
  a: { ko: entry.a.ko.replaceAll('{{contact_email}}', cmsCopy.contact_email),
       fr: entry.a.fr.replaceAll('{{contact_email}}', cmsCopy.contact_email) },
}));
export type SiteEvent = { date: string; time?: T; title: T; place: T; kind: 'school' | 'asso' | 'info'; desc?: T; tentative?: boolean };
type CmsEvent = { date: string; title_ko: string; title_fr: string; place_ko: string; place_fr: string; kind: SiteEvent["kind"]; tentative?: boolean; time_ko?: string; time_fr?: string; desc_ko?: string; desc_fr?: string };
export const EVENTS: SiteEvent[] = (cmsEvents as CmsEvent[]).map((e) => ({
  date: e.date,
  title: { ko: e.title_ko, fr: e.title_fr },
  place: { ko: e.place_ko, fr: e.place_fr },
  kind: e.kind as SiteEvent['kind'],
  ...(e.time_ko || e.time_fr ? { time: { ko: e.time_ko || '', fr: e.time_fr || '' } } : {}),
  ...(e.desc_ko || e.desc_fr ? { desc: { ko: e.desc_ko || '', fr: e.desc_fr || '' } } : {}),
  tentative: e.tentative,
}));
// Legacy Sources 컴포넌트용 정보(공개 출력 여부는 컴포넌트가 결정).
export const SOURCES = [
  { label: 'Académie de Versailles – Sections internationales', href: 'https://www.ac-versailles.fr/si92' },
  { label: 'Ville de Courbevoie', href: 'https://www.ville-courbevoie.fr/' },
];
