import { verifyJwt } from '@atproto/xrpc-server';
import { IdResolver } from '@atproto/identity';

const idResolver = new IdResolver();

export async function verifyClientAuth(
  jwtStr: string,
  serverDid: string,
  lxm: string | null = null,
): Promise<{ did: string }> {
  const payload = await verifyJwt(
    jwtStr,
    serverDid,
    lxm,
    (iss: string, forceRefresh: boolean) =>
      idResolver.did.resolveAtprotoKey(iss, forceRefresh),
  );
  return { did: payload.iss.split('#')[0]! };
}
