// Picks the voice media backend once, at startup. Both expose the same API;
// callers never need to know which one runs.
import { config } from "./config.ts";
import * as builtin from "./voice.ts";
import * as cloudflare from "./voice-cloudflare.ts";
import { legacyVoiceStates, usesLegacyGateway, legacyCommand } from './handoff.ts';

const impl = config.voice.backend === "cloudflare" ? cloudflare : builtin;

export const voiceBackend = config.voice.backend;
export const startVoice = impl.startVoice;
export const voiceAddresses = impl.voiceAddresses;
export const voiceStatesFor: typeof impl.voiceStatesFor = serverId => legacyVoiceStates(serverId) ?? impl.voiceStatesFor(serverId);
export const leaveVoice = impl.leaveVoice;
export const stopVoice = impl.stopVoice;
export const setSelfState = impl.setSelfState;
export const setSpeaking = impl.setSpeaking;
export const setServerMute: typeof impl.setServerMute = async (serverId,userId,muted) => { if(usesLegacyGateway())await legacyCommand('mute',{serverId,userId,muted});else await impl.setServerMute(serverId,userId,muted); };
export const disconnectUser: typeof impl.disconnectUser = (serverId,userId) => { if(usesLegacyGateway())void legacyCommand('disconnect-voice',{serverId,userId}).catch(()=>{});else impl.disconnectUser(serverId,userId); };
export const handleVoice = impl.handleVoice;
