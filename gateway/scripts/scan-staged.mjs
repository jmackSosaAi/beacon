#!/usr/bin/env node
// Pre-commit: scans the lines being added for secrets and personal data (same rules as Beacon's own commits).
import {execFileSync} from 'node:child_process';
import {scanText} from '../src/scan.js';
const diff=execFileSync('git',['diff','--cached','-U0','--','.',':(exclude)gateway/tests/*',':(exclude)gateway/src/scan.js'],{encoding:'utf8',maxBuffer:50e6});
const hits=scanText(diff.split('\n').filter(l=>l.startsWith('+')&&!l.startsWith('+++')).join('\n'));
if(hits.length){console.error(`blocked: staged changes look like they contain a ${hits.join(', ')}`);process.exit(1);}
