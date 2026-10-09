// Interruptible brief/career calls. Pure state machine (no I/O) so it can be tested: the socket in brief.js feeds it
// Twilio ConversationRelay events and performs the returned effects. These calls can ONLY capture notes and feedback
// (Auto tier, Jackson's own words) until he types the keypad PIN (brief.js then hands the call to voice.js turns).
// Anything else he says ("what's up Beacon", a question about the brief) is a {chat} effect: a tool-less small-talk reply.
export const norm=t=>String(t||'').toLowerCase().replace(/[^a-z0-9' ]+/g,' ').replace(/\s+/g,' ').trim();
export const KIND=/^(?:(?:ok(?:ay)?|hey|um|uh)\s+)*(?:(?:beacon|jarvis)\s+)?(notes?|feedback)\b\s*/;
export const PAUSE=/^(?:(?:ok(?:ay)?|hey|um|uh)\s+)*(?:(?:beacon|jarvis)\s+)?(?:stop|pause|hold on|hold up|wait|one sec(?:ond)?|hang on)\b\s*/;
export const RESUME=/(?:^|\s)(?:ok(?:ay)?\s+)?(?:beacon|jarvis)\s+(?:resume|continue|go on|keep going)\s*$|^(?:ok(?:ay)?\s+)?(?:resume|continue|go on|keep going)\s*$/;
const DONE=/^(?:no|nope|no thanks?|i'?m good|that'?s all|that'?s it|goodbye|bye|hang up|all good)\b/;
export const CLOSING='That’s it. Any notes or feedback? Type your PIN and press pound if you need anything else. Otherwise I’ll hang up.';
// Backchannel noise while he listens: keep reading instead of answering.
const FILLER=/^(?:(?:uh huh|mm+ ?hm+|m+|mhm|ok(?:ay)?|yeah|yep|yes|right|got it|cool|sure|nice|alright|all right|uh|um|hmm+)\s*)+$/;

const NUM={one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10};
const REPEAT=/^(?:(?:ok(?:ay)?|hey|um|uh)\s+)*(?:(?:beacon|jarvis)\s+)?(?:repeat|say that again|go back|back up|what was that|come again)(?:\s+(?:that|it|the last|last))?(?:\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten))?(?:\s+(?:sentences?|lines?))?(?:\s+back)?\b/;
// One sentence per segment, so "repeat 2 sentences back" is exact.
export const sentences=text=>String(text).split(/(?<=[.!?…])\s+(?=[A-Z0-9"'])/).map(x=>x.trim()).filter(Boolean);
export function createState(segments){return {segments:[...segments.flatMap(sentences),CLOSING],at:0,mode:'reading',kind:null,buffer:[],cut:false};}
// "repeat" = the sentence that was cut off (or just finished); "repeat 3" / "go back 3 sentences" = three before that.
export function rewind(state,text){
  const m=REPEAT.exec(norm(text));if(!m)return null;
  const n=m[1]?(NUM[m[1]]||Number(m[1])):0;
  return read(state,Math.max(0,state.at-n));
}
// Which segment was playing when Jackson spoke: the one that starts with (or contains) what had been said so far.
export function locate(state,utterance){
  const u=norm(utterance);if(!u)return state.at;
  for(let i=state.at;i<state.segments.length;i++){const s=norm(state.segments[i]);if(s.startsWith(u)||s.includes(u))return i;}
  return state.at;
}
const chat=(state,text)=>{state.mode='chat';return [{chat:String(text).trim()}];};
const read=(state,from)=>{state.mode='reading';state.at=from;state.cut=false;return [{say:state.segments.slice(from)}];};
// Returns a list of effects: {say:[...]} speak these segments in order, {save:{kind,text}}, {end:true}.
// Twilio sends `interrupt` only when he talks over speech; a prompt with no interrupt since the last read means it all played.
export function onInterrupt(state,utterance){if(state.mode==='reading'){state.at=locate(state,utterance);state.cut=true;}return [];}
export function onSpeech(state,text){
  const t=norm(text);if(!t)return [];
  if(state.mode==='capture'){
    if(RESUME.test(t)){
      const rest=String(text).replace(/[,.!?]*\s*(?:ok(?:ay)?[,\s]+)?(?:beacon|jarvis)[,\s]+(?:resume|continue|go on|keep going)[.!?]*\s*$|^\s*(?:ok(?:ay)?[,\s]+)?(?:resume|continue|go on|keep going)[.!?]*\s*$/i,'').trim();
      if(rest)state.buffer.push(rest);
      const words=state.buffer.join(' ').trim(),kind=state.kind;state.buffer=[];state.kind=null;
      return [...(words?[{save:{kind,text:words}},{say:['Saved.']}]:[{say:['Nothing to save.']}]),...read(state,state.at)];
    }
    state.buffer.push(String(text).trim());return [];
  }
  // Talking with him mid-brief: "keep going"/"resume" goes back to the brief, notes still work, anything else is chat.
  if(state.mode==='chat'){
    if(RESUME.test(t)||/^(?:keep going|go ahead|continue|carry on|go on)\b/.test(t))return read(state,state.at);
    const back=rewind(state,text);if(back)return back;
    const k=KIND.exec(t);
    if(k){state.mode='capture';state.kind=/feedback/.test(k[1])?'feedback':'note';const rest=String(text).replace(/^\W*(?:(?:ok(?:ay)?|hey|um|uh)\W+)*(?:(?:beacon|jarvis)\W+)?(?:notes?|feedback)\b\W*/i,'').trim();if(rest)state.buffer.push(rest);return [{say:['Go ahead. Say OK Beacon, resume when you’re done.']}];}
    if(DONE.test(t))return [{say:['Talk soon.']},{end:true}];
    return [{chat:String(text).trim()}];
  }
  if(state.mode==='paused'){
    if(RESUME.test(t))return read(state,state.at);
    const back=rewind(state,text);if(back)return back;
    const k=KIND.exec(t);
    state.mode='capture';state.kind=k&&/feedback/.test(k[1])?'feedback':'note';
    const rest=k?String(text).replace(/^\W*(?:(?:ok(?:ay)?|hey|um|uh)\W+)*(?:(?:beacon|jarvis)\W+)?(?:notes?|feedback)\b\W*/i,'').trim():String(text).trim();
    if(rest)state.buffer.push(rest);
    return [{say:[k?'Go ahead. Say OK Beacon, resume when you’re done.':'Got it, saving that as a note. Keep going, then say OK Beacon, resume.']}];
  }
  // Reading (including after the closing question).
  const cut=state.cut;
  if(!cut){state.at=state.segments.length-1;const m=REPEAT.exec(t);if(m&&!m[1])return read(state,0);}
  const back=rewind(state,text);if(back)return back;
  const k=KIND.exec(t);
  if(k){
    state.mode='capture';state.kind=/feedback/.test(k[1])?'feedback':'note';
    const rest=String(text).replace(/^\W*(?:(?:ok(?:ay)?|hey|um|uh)\W+)*(?:(?:beacon|jarvis)\W+)?(?:notes?|feedback)\b\W*/i,'').trim();
    if(rest)state.buffer.push(rest);
    return [{say:['Go ahead. Say OK Beacon, resume when you’re done.']}];
  }
  if(PAUSE.test(t)){state.mode='paused';return [{say:['Paused. Note or feedback? Or say resume, or repeat.']}];}
  if(state.at>=state.segments.length-1&&DONE.test(t))return [{say:['Talk soon.']},{end:true}];
  // Noise ("uh-huh") over the reading picks up the sentence that was cut off; anything else is him talking to Beacon.
  if(FILLER.test(t)&&cut)return read(state,state.at);
  return chat(state,text);
}
