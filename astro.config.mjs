import { defineConfig } from 'astro/config';

// SITE_URL, BASE_PATH 는 배포 환경에서 지정합니다.
//  - GitHub Pages(계정.github.io/asicc-site/): .github/workflows/deploy.yml 이 자동 지정
//  - 자체 도메인 또는 Firebase Hosting: 지정하지 않으면 기본값 사용
// Fail closed if a custom Pages command bypasses the test build dispatcher.
if(process.env.CF_PAGES_BRANCH==='test-cms-fr'&&(
  process.env.PUBLIC_ASICC_INTEGRATION_TEST!=='true'||process.env.PUBLIC_ASICC_BAZAAR_TEST!=='true'||
  process.env.SITE_URL!=='https://asicc-test.pages.dev'))throw new Error('test-cms-fr requires the isolated test build. Run npm run build.');
export default defineConfig({
  site: process.env.SITE_URL || 'https://asicc-parents.fr',
  base: process.env.BASE_PATH || '/',
  trailingSlash: 'always',
  build: { format: 'directory' },
});
