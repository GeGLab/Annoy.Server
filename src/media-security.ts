import type {VoiceMediaProtection} from '@distopic/protocol';
import {HttpError} from './errors.ts';
import {isMediaProtection} from './media-e2ee.ts';
/** Voice channels on both backends carry SFrame (RFC 9605) keyed by an MLS group per call.
 * Implemented and tested locally; the integration has not been independently audited.
 * Voice channels and direct calls share it; transport-only needs an explicit consent. */
export const mediaProtection=Object.freeze({e2ee:true as const,protocol:'SFrame-RFC9605/MLS-RFC9420' as const,scope:['voice','direct_calls'] as const,status:'unaudited' as const});
export function requireMediaConsent(data:Record<string,unknown>):VoiceMediaProtection {
 if(isMediaProtection(data.protection))return data.protection;
 throw new HttpError(428,'media_consent_required','Esta chamada não tem E2EE validado. Confirme explicitamente a proteção limitada ao transporte antes de continuar.');
}
