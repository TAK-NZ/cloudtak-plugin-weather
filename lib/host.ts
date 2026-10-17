// This is the only module of the plugin that imports CloudTAK app internals.
// The plugin is built into the CloudTAK bundle (AGPL combined work) and
// src/std.ts is the app's own source of the server URL and the session token.
import { getRuntimeToken, serverUrl } from '../../../src/std.ts';
import type { Host } from './types.ts';

export const host: Host = {
    origin: () => String(serverUrl).replace(/\/+$/, ''),
    token: () => getRuntimeToken(),
    fetch: (input, init) => fetch(input, init),
};
