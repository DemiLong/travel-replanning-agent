import {spawnSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
const compile=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.evals.json'],{stdio:'inherit'});
if(compile.status!==0)process.exit(compile.status??1);
mkdirSync('work/eval-build',{recursive:true});writeFileSync('work/eval-build/package.json','{"type":"commonjs"}');
const targets=['failure-classification-tests.js','execution-cancellation-tests.js','auth-rate-limit-tests.js','session-state-tests.js','protocol-contract-tests.js','validator-tests.js'];
for(const target of targets){
  const result=spawnSync(process.execPath,[`work/eval-build/evals/${target}`,...process.argv.slice(2)],{stdio:'inherit',env:process.env});
  if(result.status!==0)process.exit(result.status??1);
}
