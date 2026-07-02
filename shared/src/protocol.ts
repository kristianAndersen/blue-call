import { z } from 'zod';

const Did = z
  .string()
  .regex(/^did:[a-zA-Z0-9]+:[a-zA-Z0-9._%-]+$/, 'must be a valid DID (did:method:identifier)');

export const AuthHandshake = z.object({
  type: z.literal('auth-handshake'),
  did: Did,
  token: z.string().min(1),
});

export const PresenceOpen = z.object({
  type: z.literal('presence-open'),
  durationMs: z.number().int().positive(),
});

export const PresenceClose = z.object({
  type: z.literal('presence-close'),
});

export const PresenceBroadcast = z.object({
  type: z.literal('presence-broadcast'),
  open: z.array(
    z.object({
      did: Did,
      expiresAt: z.number(),
    }),
  ),
});

export const JoinRequest = z.object({
  type: z.literal('join-request'),
  to: Did,
});

export const SdpOffer = z.object({
  type: z.literal('sdp-offer'),
  to: Did,
  from: Did.optional(),
  sdp: z.string().min(1),
});

export const SdpAnswer = z.object({
  type: z.literal('sdp-answer'),
  to: Did,
  sdp: z.string().min(1),
});

export const IceCandidate = z.object({
  type: z.literal('ice-candidate'),
  to: Did,
  candidate: z.object({
    candidate: z.string(),
    sdpMid: z.string().nullable().optional(),
    sdpMLineIndex: z.number().nullable().optional(),
  }),
});

export const ErrorMessage = z.object({
  type: z.literal('error'),
  code: z.string().min(1),
  message: z.string(),
});

export const SignalingMessage = z.discriminatedUnion('type', [
  AuthHandshake,
  PresenceOpen,
  PresenceClose,
  PresenceBroadcast,
  JoinRequest,
  SdpOffer,
  SdpAnswer,
  IceCandidate,
  ErrorMessage,
]);

export type AuthHandshake = z.infer<typeof AuthHandshake>;
export type PresenceOpen = z.infer<typeof PresenceOpen>;
export type PresenceClose = z.infer<typeof PresenceClose>;
export type PresenceBroadcast = z.infer<typeof PresenceBroadcast>;
export type JoinRequest = z.infer<typeof JoinRequest>;
export type SdpOffer = z.infer<typeof SdpOffer>;
export type SdpAnswer = z.infer<typeof SdpAnswer>;
export type IceCandidate = z.infer<typeof IceCandidate>;
export type ErrorMessage = z.infer<typeof ErrorMessage>;
export type SignalingMessage = z.infer<typeof SignalingMessage>;
