/*
Cinny Project
Copyright 2021-present Ajay Bura
SPDX-License-Identifier: AGPL-3.0-only
https://cinny.in

Please see LICENSE file in root of repository for full details.
*/

/// <reference lib="WebWorker" />

export type {};
declare const self: ServiceWorkerGlobalScope;

type SessionInfo = {
  accessToken: string;
  baseUrl: string;
};

/**
 * How long to wait for a client to answer a session request.
 * The client answers from its main thread, which can be busy for several
 * seconds on large accounts (initial sync, timeline render). Falling back
 * to an unauthenticated fetch only ever yields 401 on servers that require
 * authenticated media, so be patient here.
 */
const SESSION_REQUEST_TIMEOUT = 15000;

let _requestId = 0;
const getRequestId = () => {
  _requestId += 1;
  return _requestId;
};

type PendingSessionRequest = {
  clientId: string;
  origin: string;
  resolve: (sessionInfo: SessionInfo | undefined) => void;
};
const pendingSessionRequests = new Map<number, PendingSessionRequest>();

/**
 * Sessions pushed by (or received from) clients, keyed by client id and origin,
 * so media fetches don't need a round trip to the client's main thread each time.
 */
const clientSessions = new Map<string, Map<string, SessionInfo>>();

const getOrigin = (url: string): string | undefined => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

function setClientSession(clientId: string, session: SessionInfo) {
  const origin = getOrigin(session.baseUrl);
  if (!origin) return;
  const sessions = clientSessions.get(clientId) ?? new Map<string, SessionInfo>();
  sessions.set(origin, session);
  clientSessions.set(clientId, sessions);
}

function getClientSession(clientId: string, origin: string): SessionInfo | undefined {
  return clientSessions.get(clientId)?.get(origin);
}

async function cleanupClientSessions() {
  const clients = await self.clients.matchAll();
  const ids = new Set(clients.map((c) => c.id));
  Array.from(clientSessions.keys()).forEach((id) => {
    if (!ids.has(id)) clientSessions.delete(id);
  });
}

const isSessionInfo = (accessToken: unknown, baseUrl: unknown): boolean =>
  typeof accessToken === 'string' && typeof baseUrl === 'string';

async function requestSession(clientId: string, origin: string): Promise<SessionInfo | undefined> {
  const client = await self.clients.get(clientId);
  if (!client) return undefined;

  const id = getRequestId();

  const sessionPromise = new Promise<SessionInfo | undefined>((resolve) => {
    pendingSessionRequests.set(id, { clientId, origin, resolve });
    client.postMessage({ type: 'session-request', id, origin });
    // Pages loaded before the multi-account service worker only understand
    // the legacy request and answer it with a `setSession` message.
    client.postMessage({ type: 'requestSession' });
  });

  const timeout = new Promise<undefined>((resolve) => {
    setTimeout(() => {
      resolve(undefined);
      pendingSessionRequests.delete(id);
    }, SESSION_REQUEST_TIMEOUT);
  });

  const session = await Promise.race([sessionPromise, timeout]);
  return session ?? getClientSession(clientId, origin);
}

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      await cleanupClientSessions();
    })()
  );
});

/**
 * Receive session updates from clients
 */
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const client = event.source as Client | null;
  if (!client) return;

  const { type, id, accessToken, baseUrl } = event.data || {};

  if (type === 'session-request') {
    const request = pendingSessionRequests.get(id);
    pendingSessionRequests.delete(id);
    if (isSessionInfo(accessToken, baseUrl)) {
      setClientSession(client.id, { accessToken, baseUrl });
      request?.resolve({ accessToken, baseUrl });
    } else {
      request?.resolve(undefined);
    }
    return;
  }

  if (type === 'setSession') {
    if (isSessionInfo(accessToken, baseUrl)) {
      setClientSession(client.id, { accessToken, baseUrl });
      // resolve requests still waiting on this client for this origin
      const origin = getOrigin(baseUrl);
      Array.from(pendingSessionRequests.entries()).forEach(([reqId, request]) => {
        if (request.clientId !== client.id || request.origin !== origin) return;
        pendingSessionRequests.delete(reqId);
        request.resolve({ accessToken, baseUrl });
      });
    }
    cleanupClientSessions();
    return;
  }

  if (type === 'clearSessions') {
    clientSessions.delete(client.id);
  }
});

const MEDIA_PATHS = ['/_matrix/client/v1/media/download', '/_matrix/client/v1/media/thumbnail'];

function mediaPath(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return MEDIA_PATHS.some((p) => pathname.startsWith(p));
  } catch {
    return false;
  }
}

function validMediaRequest(url: string, baseUrl: string): boolean {
  return MEDIA_PATHS.some((p) => {
    const validUrl = new URL(p, baseUrl);
    return url.startsWith(validUrl.href);
  });
}

function fetchConfig(token: string): RequestInit {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
    },
    cache: 'default',
  };
}

self.addEventListener('fetch', (event: FetchEvent) => {
  const { url, method } = event.request;

  if (method !== 'GET' || !mediaPath(url)) return;

  const { clientId } = event;
  if (!clientId) return;

  const { origin } = new URL(url);
  const cached = getClientSession(clientId, origin);
  if (cached && validMediaRequest(url, cached.baseUrl)) {
    event.respondWith(fetch(url, fetchConfig(cached.accessToken)));
    return;
  }

  event.respondWith(
    requestSession(clientId, origin).then((s) => {
      if (s && validMediaRequest(url, s.baseUrl)) {
        return fetch(url, fetchConfig(s.accessToken));
      }
      return fetch(event.request);
    })
  );
});
