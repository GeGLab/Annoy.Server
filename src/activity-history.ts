import {randomUUID} from "node:crypto";
import type {ActivityHistoryEntry,UserActivity} from "@distopic/protocol";
import {all,now,one,run,tx} from "./db.ts";
import {sendToAudience,sendToUser} from "./events.ts";

const processKey=randomUUID();
// A restart confirms interruption, not an exact activity end time.
run("UPDATE activity_history SET completed=1 WHERE completed=0");
export const historyEnabled=(userId:string)=>!!one<{history_enabled:number}>("SELECT history_enabled FROM profile_privacy WHERE user_id=?",userId)?.history_enabled;
export function invalidateProfile(userId:string):void {
  const event={t:"PROFILE_INVALIDATE" as const,d:{userId}};
  sendToAudience(userId,event);sendToUser(userId,event);
}
function prune(userId:string):void {
  run("DELETE FROM activity_history WHERE user_id=? AND last_seen_at<?",userId,new Date(Date.now()-30*86400_000).toISOString());
  run("DELETE FROM activity_history WHERE user_id=? AND completed=1 AND id NOT IN (SELECT id FROM activity_history WHERE user_id=? AND completed=1 ORDER BY last_seen_at DESC,id DESC LIMIT 3)",userId,userId);
}
for(const row of all<{user_id:string}>("SELECT DISTINCT user_id FROM activity_history"))prune(row.user_id);
export function expireActivityHistory():void {run("DELETE FROM activity_history WHERE last_seen_at<?",new Date(Date.now()-30*86400_000).toISOString());}
setInterval(expireActivityHistory,60_000).unref();
export function activityHistory(userId:string):ActivityHistoryEntry[] {
  prune(userId);
  return all<ActivityHistoryEntry>("SELECT id,kind,provider,name,started_at AS startedAt,ended_at AS endedAt FROM activity_history WHERE user_id=? AND completed=1 ORDER BY last_seen_at DESC,id DESC LIMIT 3",userId);
}
export function setHistoryConsent(userId:string,enabled:boolean):void {
  tx(()=>{run("INSERT INTO profile_privacy(user_id,history_enabled) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET history_enabled=excluded.history_enabled",userId,enabled?1:0);if(!enabled)run("DELETE FROM activity_history WHERE user_id=?",userId);});
  invalidateProfile(userId);
}
export function deleteActivityHistory(userId:string):void {run("DELETE FROM activity_history WHERE user_id=?",userId);invalidateProfile(userId);}

/** Persists only provider, kind and application/track name; never file, project, artwork or detector paths. */
export function observeActivityHistory(connectionId:number,userId:string,deviceId:string|null,activities:readonly UserActivity[],confirmed=true):void {
  if(!historyEnabled(userId))return;
  const key=`${processKey}:${connectionId}`,at=now();let changed=false;
  tx(()=>{
    const active=all<{id:string;activity_key:string}>("SELECT id,activity_key FROM activity_history WHERE user_id=? AND connection_key=? AND completed=0",userId,key);
    const safe=activities.map(activity=>({...activity,name:activity.kind==="development"?activity.provider:/^(?:[a-z]:[\\/]|\/|file:)/i.test(activity.name)?"Atividade":activity.name}));
    const next=new Map(safe.map(activity=>[JSON.stringify([activity.kind,activity.provider,activity.appId??activity.name]),activity]));
    for(const entry of active)if(!next.has(entry.activity_key)){run("UPDATE activity_history SET completed=1,ended_at=?,last_seen_at=? WHERE id=?",confirmed?at:null,at,entry.id);changed=true;}
    for(const [activityKey,activity] of next){
      const existing=active.find(entry=>entry.activity_key===activityKey);
      if(existing)run("UPDATE activity_history SET last_seen_at=? WHERE id=?",at,existing.id);
      else {
        if(deviceId)run("UPDATE activity_history SET completed=1 WHERE user_id=? AND device_id=? AND activity_key=? AND completed=0 AND connection_key<>?",userId,deviceId,activityKey,key);
        run("INSERT INTO activity_history(id,user_id,connection_key,device_id,activity_key,kind,provider,name,started_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?)",randomUUID(),userId,key,deviceId,activityKey,activity.kind,activity.provider,activity.name,at,at);
      }
    }
    prune(userId);
  });
  if(changed)invalidateProfile(userId);
}
