// Thin Telegram Bot API client. No imports, so service.js can use it without a cycle.
export async function tg(env,method,payload){
  if(!env.TELEGRAM_BOT_TOKEN)return null;
  const r=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
  if(!r.ok){console.error(JSON.stringify({event:'telegram_failed',method,status:r.status}));return null;}
  return r.json();
}
// Plain text only, link previews off, and only ever to the owner's private chat.
export function sendTelegram(env,text,extra={}){
  if(!env.TELEGRAM_OWNER_ID)return null;
  return tg(env,'sendMessage',{chat_id:Number(env.TELEGRAM_OWNER_ID),text:String(text).slice(0,4000),link_preview_options:{is_disabled:true},...extra});
}
// File upload (sendDocument or sendPhoto) as multipart, only to the owner's private chat. Caption is plain text.
export async function sendTelegramFile(env,{bytes,filename,contentType,caption}){
  if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_OWNER_ID)return null;
  const photo=/^image\/(jpeg|png|webp)$/.test(contentType)&&bytes.byteLength<=10*1024*1024,method=photo?'sendPhoto':'sendDocument',form=new FormData();
  form.append('chat_id',String(Number(env.TELEGRAM_OWNER_ID)));if(caption)form.append('caption',String(caption).slice(0,1000));
  form.append(photo?'photo':'document',new Blob([bytes],{type:contentType||'application/octet-stream'}),filename);
  const r=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',body:form,signal:AbortSignal.timeout(120000)});
  if(!r.ok){console.error(JSON.stringify({event:'telegram_failed',method,status:r.status}));return null;}
  return r.json();
}
