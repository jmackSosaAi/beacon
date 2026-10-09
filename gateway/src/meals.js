import {all,run,nowIso} from './service.js';
import {cleanText,localParts} from './core.js';

const n=(v,max)=>Number.isFinite(Number(v))&&Number(v)>=0&&Number(v)<=max?Math.round(Number(v)):null;
// Meals are Auto tier: Jackson's own data, logged immediately with an undo window.
export function validateMeal(action){
  if(!Array.isArray(action.items)||!action.items.length||action.items.length>20)return null;
  const items=action.items.map(i=>({name:cleanText(i.name,120),calories:n(i.calories,5000),protein_g:n(i.protein_g,400),carbs_g:n(i.carbs_g,800),fat_g:n(i.fat_g,400)}));
  if(items.some(i=>!i.name||i.calories===null||i.protein_g===null||i.carbs_g===null||i.fat_g===null))return null;
  const at=action.eaten_at&&!Number.isNaN(Date.parse(action.eaten_at))?new Date(action.eaten_at):new Date();
  if(at.getTime()>Date.now()+3600000||at.getTime()<Date.now()-3*86400000)return null;
  return {type:'meal',items,eaten_at:at.toISOString(),description:cleanText(action.description||items.map(i=>i.name).join(', '),300)};
}
const sum=(items,k)=>items.reduce((t,i)=>t+i[k],0);
export async function logMeal(env,meal,source){
  const id=crypto.randomUUID(),t={calories:sum(meal.items,'calories'),protein_g:sum(meal.items,'protein_g'),carbs_g:sum(meal.items,'carbs_g'),fat_g:sum(meal.items,'fat_g')};
  await run(env,'INSERT INTO meals VALUES(?,?,?,?,?,?,?,?,?,?)',id,meal.eaten_at,meal.description,JSON.stringify(meal.items),t.calories,t.protein_g,t.carbs_g,t.fat_g,String(source).slice(0,20),nowIso());
  await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),`meal:logged:${String(source).slice(0,20)}`,id,nowIso());
  return {id,...t};
}
export async function undoMeal(env,id){
  const r=await run(env,'DELETE FROM meals WHERE id=? AND created_at>?',String(id).slice(0,64),new Date(Date.now()-86400000).toISOString());
  if(r.meta.changes)await run(env,'INSERT INTO audit VALUES(?,?,?,?)',crypto.randomUUID(),'meal:undone',id,nowIso());
  return r.meta.changes>0;
}
// Totals for a Chicago calendar day.
export async function dayTotals(env,date){
  const rows=(await all(env,'SELECT * FROM meals WHERE eaten_at>? AND eaten_at<? ORDER BY eaten_at',new Date(Date.parse(date+'T00:00:00Z')-86400000).toISOString(),new Date(Date.parse(date+'T00:00:00Z')+2*86400000).toISOString())).filter(m=>localParts(new Date(m.eaten_at)).date===date);
  return {meals:rows,calories:sum(rows,'calories'),protein_g:sum(rows,'protein_g'),carbs_g:sum(rows,'carbs_g'),fat_g:sum(rows,'fat_g')};
}
export async function targets(env){const p=JSON.parse((await env.DB.prepare("SELECT value FROM settings WHERE id='preferences'").first()).value);return {calories:p.calorieTarget||null,protein_g:p.proteinTarget||null};}
export function totalsLine(t,goal){
  const cal=goal.calories?`${t.calories} of ${goal.calories} calories (${goal.calories-t.calories>=0?`${goal.calories-t.calories} left`:`${t.calories-goal.calories} over`})`:`${t.calories} calories`;
  return `${cal}, ${t.protein_g}g protein${goal.protein_g?` of ${goal.protein_g}g`:''}, ${t.carbs_g}g carbs, ${t.fat_g}g fat across ${t.meals.length} meal${t.meals.length===1?'':'s'}`;
}
export async function mealsCsv(env){
  const rows=await all(env,'SELECT * FROM meals ORDER BY eaten_at');
  const q=v=>`"${String(v).replace(/"/g,'""')}"`;
  return ['date,time,description,calories,protein_g,carbs_g,fat_g,items',...rows.map(m=>{const l=localParts(new Date(m.eaten_at));return [l.date,l.time,q(m.description),m.calories,m.protein_g,m.carbs_g,m.fat_g,q(JSON.parse(m.items).map(i=>`${i.name} (${i.calories})`).join('; '))].join(',');})].join('\n');
}
