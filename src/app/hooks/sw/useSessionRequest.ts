/*
Cinny Project
Copyright 2021-present Ajay Bura
SPDX-License-Identifier: AGPL-3.0-only
https://cinny.in

Please see LICENSE file in root of repository for full details.
*/

import { useEffect } from 'react';
import { Session } from '../../../client/sessions';

const getServiceWorker = () => {
  if ('serviceWorker' in navigator) {
    return navigator.serviceWorker;
  }
  return undefined;
};

const postToServiceWorker = async (message: unknown) => {
  const sw = getServiceWorker();
  if (!sw) return;
  if (sw.controller) {
    sw.controller.postMessage(message);
    return;
  }
  const registration = await sw.getRegistration();
  registration?.active?.postMessage(message);
};

export const useSessionRequest = (sessions: Session[], userId?: string) => {
  useEffect(() => {
    const userSession = sessions.find((s) => s.userId === userId);

    // Push the active session up front so the service worker can authenticate
    // media without asking this (possibly busy) main thread on every request.
    const pushSession = () => {
      postToServiceWorker({ type: 'clearSessions' });
      if (userSession) {
        postToServiceWorker({
          type: 'setSession',
          baseUrl: userSession.baseUrl,
          accessToken: userSession.accessToken,
        });
      }
    };
    pushSession();

    const handleSWMessages = (ev: MessageEvent<any>) => {
      const { type, id, origin } = ev.data ?? {};

      if (type === 'requestSession') {
        // legacy request from an older service worker
        if (userSession) {
          postToServiceWorker({
            type: 'setSession',
            baseUrl: userSession.baseUrl,
            accessToken: userSession.accessToken,
          });
        }
        return;
      }

      if (type !== 'session-request' || typeof origin !== 'string') return;

      const session =
        userSession && userSession.baseUrl.startsWith(origin)
          ? userSession
          : sessions.find((s) => s.baseUrl.startsWith(origin));

      if (!session) return;

      postToServiceWorker({
        type: 'session-request',
        id,
        baseUrl: session.baseUrl,
        accessToken: session.accessToken,
      });
    };

    const sw = getServiceWorker();
    sw?.addEventListener('message', handleSWMessages);
    sw?.addEventListener('controllerchange', pushSession);
    return () => {
      sw?.removeEventListener('message', handleSWMessages);
      sw?.removeEventListener('controllerchange', pushSession);
    };
  }, [sessions, userId]);
};
