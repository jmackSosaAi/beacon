#!/usr/bin/env node
// Moves the Mac node token from ~/.config/jarvis/node_token into the macOS Keychain (service jarvis-node),
// verifies it reads back, then deletes the file. The Worker secret NODE_TOKEN remains the source of truth.
import {readFileSync,existsSync,unlinkSync} from 'node:fs';
import {homedir} from 'node:os';
import {execFileSync} from 'node:child_process';
const file=homedir()+'/.config/jarvis/node_token',sec=args=>execFileSync('/usr/bin/security',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const read=()=>{try{return sec(['find-generic-password','-s','jarvis-node','-a','jarvis','-w']);}catch{return null;}};
if(!existsSync(file)){console.log(read()?'Already in Keychain; no file left.':'No token file and nothing in Keychain.');process.exit(0);}
const token=readFileSync(file,'utf8').trim();
sec(['add-generic-password','-s','jarvis-node','-a','jarvis','-l','Beacon Mac node token','-w',token,'-U','-T','/usr/bin/security']);
if(read()!==token){console.log('Keychain read-back failed; file kept.');process.exit(1);}
unlinkSync(file);console.log('Node token is in the Keychain (jarvis-node); file deleted.');
