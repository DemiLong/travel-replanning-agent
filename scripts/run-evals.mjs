import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
const compile=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.evals.json'],{stdio:'inherit'});
if(compile.status!==0)process.exit(compile.status??1);
mkdirSync('work/eval-build',{recursive:true});writeFileSync('work/eval-build/package.json','{"type":"commonjs"}');
const target='validator-tests.js';
const result=spawnSync(process.execPath,[`work/eval-build/evals/${target}`,...process.argv.slice(2)],{stdio:'inherit',env:process.env});
process.exit(result.status??1);
