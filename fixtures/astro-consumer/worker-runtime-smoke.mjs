import { onRequest } from 'astro-cloudflare-pages-headers/middleware';

export default {
  async fetch(request) {
    return onRequest({ url: new URL(request.url) }, async () => {
      const url = new URL(request.url);
      if (url.pathname === '/api' && request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: { Allow: 'GET, HEAD, OPTIONS' } });
      }
      if (url.pathname === '/api' && request.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { Allow: 'GET, HEAD, OPTIONS' } });
      }
      if (url.pathname === '/api' && request.method === 'GET') {
        return new Response('{"ok":true}', {
          headers: {
            'Content-Type': 'application/json',
            'Content-Security-Policy': "script-src 'nonce-worker-app'",
            'Cache-Control': 'private, no-store',
          },
        });
      }
      if (url.pathname === '/websocket' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
        const pair = new WebSocketPair();
        pair[1].accept();
        return new Response(null, { status: 101, webSocket: pair[0], headers: { 'X-Application-WebSocket': 'preserved' } });
      }
      return new Response('missing', { status: 404 });
    });
  },
};
