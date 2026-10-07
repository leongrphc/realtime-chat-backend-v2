export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/') || url.pathname.startsWith('/health/')) {
      const upstream = new URL(env.API_ORIGIN);
      url.protocol = upstream.protocol;
      url.host = upstream.host;
      const headers = new Headers(request.headers);
      headers.set('X-Chat-Proxy-Secret', env.EDGE_PROXY_SECRET);
      headers.set('X-Chat-Client-IP', request.headers.get('CF-Connecting-IP') ?? 'unknown');
      headers.delete('X-Forwarded-For');
      return fetch(new Request(url, { method: request.method, headers, body: request.body, redirect: 'manual' }));
    }
    return env.ASSETS.fetch(request);
  }
};
