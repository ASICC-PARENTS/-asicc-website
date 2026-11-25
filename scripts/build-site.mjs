import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
// Never fall back to production Firebase for the baseline test branch.
const baseline=process.env.CF_PAGES_BRANCH==='test-cms-fr'||process.env.ASICC_BASELINE_TEST==='true';
const args=baseline?[resolve('scripts/build-integration.mjs')]:[resolve('node_modules/astro/astro.js'),'build'];
const result=spawnSync(process.execPath,args,{env:process.env,stdio:'inherit'});
if(result.error)throw result.error;
process.exit(result.status??1);
