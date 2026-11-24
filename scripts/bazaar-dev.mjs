import {loadEnv} from 'vite';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';

const env={...loadEnv('development',process.cwd(),'PUBLIC_ASICC_BAZAAR_'),...process.env};
const required=['PUBLIC_ASICC_BAZAAR_TEST','PUBLIC_ASICC_BAZAAR_TEST_API_KEY','PUBLIC_ASICC_BAZAAR_TEST_APP_ID','PUBLIC_ASICC_BAZAAR_WORKER_URL'];
const missing=required.filter(k=>!env[k]?.trim());
const wrong=[];
if(env.PUBLIC_ASICC_BAZAAR_TEST!=='true')wrong.push('PUBLIC_ASICC_BAZAAR_TEST must be true');
if(env.PUBLIC_ASICC_BAZAAR_EMULATOR==='true')wrong.push('PUBLIC_ASICC_BAZAAR_EMULATOR must not be true');
if(env.PUBLIC_ASICC_BAZAAR_TEST_API_KEY==='test-project-api-key-required')wrong.push('Firebase test API key is a placeholder');
if(env.PUBLIC_ASICC_BAZAAR_WORKER_URL && !/^https:\/\/asicc-bazaar-test-api\.falling-hall-f390\.workers\.dev\/?$/.test(env.PUBLIC_ASICC_BAZAAR_WORKER_URL))wrong.push('Worker URL is not the ASICC isolated test Worker');
if(missing.length||wrong.length){
 console.error('BAZAAR TEST CONFIGURATION NOT READY');
 if(missing.length)console.error('Missing: '+missing.join(', '));
 wrong.forEach(x=>console.error(x));
 console.error('Use the existing test web app settings in .env.local. No secret values are printed.');
 process.exit(1);
}
const server=createServer();
try{
 await new Promise((ok,fail)=>{server.once('error',fail);server.listen(4321,'127.0.0.1',ok);});
 await new Promise(ok=>server.close(ok));
}catch{
 console.error('Port 4321 is occupied. Stop the previous Astro server first. No alternate port will be used.');
 process.exit(1);
}
console.log('BAZAAR TEST CONFIGURATION READY · isolated Firebase test project · test Worker · 127.0.0.1:4321');
const child=spawn(process.execPath,[resolve('node_modules/astro/astro.js'),'dev','--host','127.0.0.1','--port','4321'],{stdio:'inherit',env});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??0;});
