#!/usr/bin/env node
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const filename=process.argv[2];if(!filename)throw new Error('Usage: node scripts/configure-google.mjs /path/to/google-web-client.json');
const client=JSON.parse(readFileSync(filename,'utf8')).web;
const redirect='https://your-worker.example.workers.dev/oauth/google/callback';
if(!client?.client_id||!client?.client_secret||!client.redirect_uris?.includes(redirect))throw new Error('Download a Web application OAuth client with the Beacon callback URI configured.');
const dir=mkdtempSync(tmpdir()+'/jarvis-google-');
try{const path=dir+'/secrets.json';writeFileSync(path,JSON.stringify({GOOGLE_CLIENT_ID:client.client_id,GOOGLE_CLIENT_SECRET:client.client_secret}),{mode:0o600});const r=spawnSync('npx',['wrangler','secret','bulk',path],{stdio:'inherit',cwd:new URL('..',import.meta.url)});if(r.status!==0)throw new Error('Secret installation failed');console.log('Open Beacon → Connections → Connect Google to authorize your account.');}finally{rmSync(dir,{recursive:true,force:true});}
