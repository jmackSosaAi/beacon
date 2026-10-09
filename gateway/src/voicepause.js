// Pause/note/feedback/resume for Jackson's own (PIN-verified) conversation calls, matching brief calls (briefcall.js).
// Pure state machine: "note …" or "feedback …" (even mid-reply) captures his words until "OK Beacon, resume";
// "hold on"/"wait"/"stop" pauses. Resume picks up the reply at the sentence that was cut off.
import {norm,KIND,PAUSE,RESUME,sentences} from './briefcall.js';

const STRIP_KIND=/^\W*(?:(?:ok(?:ay)?|hey|um|uh)\W+)*(?:beacon\W+)?(?:notes?|feedback)\b\W*/i;
const STRIP_RESUME=/[,.!?]*\s*(?:ok(?:ay)?[,\s]+)?beacon[,\s]+(?:resume|continue|go on|keep going)[.!?]*\s*$|^\s*(?:ok(?:ay)?[,\s]+)?(?:resume|continue|go on|keep going)[.!?]*\s*$/i;
// Only a bare pause word pauses ("wait, what's due Friday?" is a question, not a pause).
const ONLY_PAUSE=t=>PAUSE.test(t)&&!t.replace(PAUSE,'').replace(/\b(?:a|a sec(?:ond)?|a minute|beacon|please|for a sec(?:ond)?)\b/g,'').trim();
const START='Go ahead. Say OK Beacon, resume when you’re done.';
// "what?", "say that again", "repeat": replay the last reply (logged as a voice_what correction by voice.js).
export const WHAT=/^\W*(?:(?:ok(?:ay)?|hey|um|uh)\W+)*(?:beacon\W+)?(?:what|huh|pardon|sorry|come again|say that again|say again|repeat(?: that)?)\W*$/i;

export function createPause(){return {mode:'talk',kind:null,buffer:[],last:[],at:0};}
// Called with each reply Beacon speaks, so a resume can replay the rest of it. Assumed fully heard unless interrupted.
export function spoke(state,reply){state.last=sentences(reply);state.at=state.last.length;}
// Twilio reports how much of the reply was heard before he cut in; find that sentence.
export function interrupted(state,heard){
  const h=norm(heard);if(!h||!state.last.length)return;
  let i=state.last.findIndex(s=>norm(s).startsWith(h)||norm(s).includes(h));
  if(i<0){let n=0;i=state.last.findIndex(s=>(n+=norm(s).length+1)>h.length);}
  state.at=i<0?state.last.length:i;
}
const rest=state=>state.last.slice(state.at);
const pickUp=state=>{state.mode='talk';const r=rest(state);return r.length?[{say:r.join(' '),resumed:true}]:[{say:'Okay, I’m listening.'}];};
// "Note, buy ink. OK Beacon, resume" in one breath saves right away.
const capture=(state,kind,text)=>{state.mode='capture';state.kind=kind;state.buffer=[];if(RESUME.test(norm(text)))return finish(state,text);if(text)state.buffer.push(text);return [{say:START}];};
function finish(state,text){
  const tail=String(text).replace(STRIP_RESUME,'').trim();if(tail)state.buffer.push(tail);
  const words=state.buffer.join(' ').trim(),kind=state.kind;state.buffer=[];state.kind=null;
  return [...(words?[{save:{kind,text:words}},{say:kind==='feedback'?'Feedback saved.':'Noted.'}]:[{say:'Nothing to save.'}]),...pickUp(state)];
}
// Returns null when the utterance is a normal turn for the conversation model; otherwise effects:
// {say:text,resumed?:true} and {save:{kind,text}}.
export function onSpeech(state,text){
  const t=norm(text);if(!t)return state.mode==='talk'?null:[];
  if(state.mode==='capture'){
    if(RESUME.test(t))return finish(state,text);
    state.buffer.push(String(text).trim());return [];
  }
  const k=KIND.exec(t);
  if(state.mode==='paused'){
    if(RESUME.test(t))return pickUp(state);
    return capture(state,k&&/feedback/.test(k[1])?'feedback':'note',(k?String(text).replace(STRIP_KIND,''):String(text)).trim());
  }
  if(k)return capture(state,/feedback/.test(k[1])?'feedback':'note',String(text).replace(STRIP_KIND,'').trim());
  if(ONLY_PAUSE(t)){state.mode='paused';return [{say:'Paused. Note or feedback? Or say resume.'}];}
  if(WHAT.test(text))return [{say:state.last.length?state.last.join(' '):'I haven’t said anything yet.',replay:true}];
  if(RESUME.test(t)&&state.at<state.last.length)return pickUp(state);
  return null;
}
// Hanging up mid-note still keeps what he said.
export function unsaved(state){const words=state.mode==='capture'?state.buffer.join(' ').trim():'';return words?{kind:state.kind,text:words}:null;}
