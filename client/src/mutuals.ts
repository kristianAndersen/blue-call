const APPVIEW_ORIGIN = 'https://public.api.bsky.app';
const GET_FOLLOWS_PATH = '/xrpc/app.bsky.graph.getFollows';
const GET_FOLLOWERS_PATH = '/xrpc/app.bsky.graph.getFollowers';

export interface Profile {
  did: string;
  handle: string;
  displayName?: string;
}

interface GraphResponse {
  follows?: Profile[];
  followers?: Profile[];
  cursor?: string;
}

async function fetchAll(path: 'follows' | 'followers', actor: string): Promise<Profile[]> {
  const rpcPath = path === 'follows' ? GET_FOLLOWS_PATH : GET_FOLLOWERS_PATH;
  const profiles: Profile[] = [];
  let cursor: string | undefined;

  for (;;) {
    const url = new URL(rpcPath, APPVIEW_ORIGIN);
    url.searchParams.set('actor', actor);
    if (cursor !== undefined) url.searchParams.set('cursor', cursor);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`AppView request to ${rpcPath} failed: ${response.status}`);
    }

    const body = (await response.json()) as GraphResponse;
    const page = body[path] ?? [];
    profiles.push(...page);

    if (body.cursor === undefined) break;
    cursor = body.cursor;
  }

  return profiles;
}

export async function fetchMutuals(actorDid: string): Promise<Map<string, Profile>> {
  const [follows, followers] = await Promise.all([
    fetchAll('follows', actorDid),
    fetchAll('followers', actorDid),
  ]);

  const followsByDid = new Map(follows.map((profile) => [profile.did, profile]));
  const mutuals = new Map<string, Profile>();

  for (const profile of followers) {
    const followed = followsByDid.get(profile.did);
    if (followed !== undefined) mutuals.set(profile.did, followed);
  }

  return mutuals;
}
