// Picks the voice media backend once, at startup. Both expose the same API;
// callers never need to know which one runs.
import { config } from "./config.ts";
import * as builtin from "./voice.ts";
import * as cloudflare from "./voice-cloudflare.ts";

const impl = config.voice.backend === "cloudflare" ? cloudflare : builtin;

export const voiceBackend = config.voice.backend;
export const startVoice = impl.startVoice;
export const voiceAddresses = impl.voiceAddresses;
export const voiceStatesFor = impl.voiceStatesFor;
export const leaveVoice = impl.leaveVoice;
export const stopVoice = impl.stopVoice;
export const setSelfState = impl.setSelfState;
export const setSpeaking = impl.setSpeaking;
export const setServerMute = impl.setServerMute;
export const disconnectUser = impl.disconnectUser;
export const handleVoice = impl.handleVoice;
