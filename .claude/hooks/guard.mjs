#!/usr/bin/env node
// Laptop guard (ROADMAP M0): Claude Code sessions in this repo can't read keys, finance data, SSH keys or the
// wrangler login. Blocks Read/Edit/Grep/Glob paths and shell commands that name them. Beacon scripts that read
// keys internally (node gateway/scripts/*.mjs, wrangler itself) still work because their commands don't name the files.
let input='';process.stdin.on('data',d=>input+=d).on('end',()=>{
  let e;try{e=JSON.parse(input);}catch{process.exit(0);}
  const t=e.tool_input||{},text=[t.command,t.file_path,t.path,t.pattern,t.glob,t.notebook_path].filter(Boolean).join(' ');
  const PROTECTED=[[/\.config\/beacon/,'~/.config/jarvis (keys)'],[/(^|[\s"'=:(\/~])\.ssh(\/|\b)/,'~/.ssh'],[/(^|[\s"'=:(])(\.\/)?finance\/|\/Beacon\/finance\b|\b(?:cd|ls|cat|cp|mv|tar|zip|open|find|rg|grep\s+-\w*r\w*)\s+(?:\S+\s+)*?(?:\.\/)?finance(?:["'\s]|$)/,'finance/'],
    [/\.wrangler\/config|Preferences\/\.wrangler/,'the wrangler login'],[/\.dev\.vars/,'.dev.vars'],[/open-beacon\.html/,'a Beacon sign-in link']];
  const hit=PROTECTED.find(([re])=>re.test(text));
  if(!hit)process.exit(0);
  process.stderr.write(`Blocked by the Beacon laptop guard: this touches ${hit[1]}. Use the Beacon scripts (node gateway/scripts/…) instead, or ask Jackson to run it himself.`);
  process.exit(2);
});
