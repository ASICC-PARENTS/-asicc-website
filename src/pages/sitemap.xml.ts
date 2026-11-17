import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';

// Public site pages only. Member login/signup/admin pages are intentionally excluded.
const publicPaths = [
  '',
  'about/',
  'section/',
  'section/guide/',
  'admission/',
  'news/',
  'events/',
  'contact/',
];

const escapeXml = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
})[char] ?? char);

export const GET: APIRoute = async ({ site }) => {
  const origin = new URL(site?.origin ?? 'https://asicc-parents.fr');
  const paths = ['ko', 'fr'].flatMap((lang) => publicPaths.map((path) => `/${lang}/${path}`));
  const news = await getCollection('news', ({ data }) => !data.draft);
  for (const article of news) {
    const [lang, slug] = article.id.split('/');
    if ((lang === 'ko' || lang === 'fr') && slug) paths.push(`/${lang}/news/${slug}/`);
  }
  const urls = [...new Set(paths)].map((path) =>
    `  <url><loc>${escapeXml(new URL(path, origin).toString())}</loc></url>`
  );
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
