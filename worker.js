/**
 * 闯哥影视 —— 视频中转 Worker（Cloudflare）
 *
 * 它解决三件事：
 *   1. 补 CORS 头         —— 采集站的 m3u8 基本不带 Access-Control-Allow-Origin，hls.js 会被浏览器拦死
 *   2. 伪装 Referer       —— 多数采集站校验防盗链，不带对的头直接 403
 *   3. 重写 m3u8 里所有 URI —— 只补响应头没用，分片地址也得走中转，否则分片照样被挡
 *
 * 部署（两种方式，任选其一）：
 *
 *   A. 命令行（推荐）
 *      npm i -g wrangler
 *      wrangler login
 *      wrangler deploy worker.js --name vrelay
 *      → 输出形如 https://vrelay.你的子域.workers.dev
 *
 *   B. 网页
 *      dash.cloudflare.com → Workers & Pages → Create → Worker
 *      把本文件全部内容粘进去 → Deploy
 *
 * 部署完把域名填回 index.html 的 RELAY_BASE。
 */

// ============ 可选：限制只允许你的站点调用（防止别人白嫖你的流量） ============
// 留空数组 [] = 不限制（方便调试）。上线后建议填上，例如：
//   const ALLOW_ORIGINS = ['https://你的站.com', 'https://username.github.io'];
const ALLOW_ORIGINS = [];

const CORS_BASE = {
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, X-Cache',
};

function corsHeaders(origin) {
  const h = { ...CORS_BASE };
  if (!ALLOW_ORIGINS.length) {
    h['Access-Control-Allow-Origin'] = '*';
  } else if (origin && ALLOW_ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Vary'] = 'Origin';
  }
  return h;
}

/** 把 m3u8 里所有 URI 都替换成走本 Worker 的地址 */
function rewriteManifest(text, baseUrl, origin) {
  const abs = (u) => {
    try {
      return new URL(u, baseUrl).href;
    } catch (e) {
      return u;
    }
  };
  const wrap = (u) => origin + '/p?u=' + encodeURIComponent(abs(u));

  return text
    .split(/\r?\n/)
    .map((line) => {
      const s = line.trim();
      if (!s) return line;
      if (s.startsWith('#')) {
        // EXT-X-KEY（AES 加密的 key）、EXT-X-MAP（fMP4 的 init 段）、EXT-X-MEDIA（音轨）都必须换
        return line.replace(/URI="([^"]+)"/g, (m, u) => 'URI="' + wrap(u) + '"');
      }
      return wrap(s);
    })
    .join('\n');
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = url.origin;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
    }

    // 健康检查：部署后浏览器直接打开根路径，看到 ok 就说明成功
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('ok · 闯哥影视中转已就绪\n用法：/p?u=<encodeURIComponent(源地址)>', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders('*') },
      });
    }

    if (url.pathname !== '/p') {
      return new Response('404', { status: 404, headers: corsHeaders('*') });
    }

    const target = url.searchParams.get('u');
    if (!target) return new Response('missing u', { status: 400, headers: corsHeaders('*') });

    let t;
    try {
      t = new URL(target);
    } catch (e) {
      return new Response('bad url', { status: 400, headers: corsHeaders('*') });
    }
    if (t.protocol !== 'http:' && t.protocol !== 'https:') {
      return new Response('protocol not allowed', { status: 400, headers: corsHeaders('*') });
    }

    const isManifest = /\.m3u8(\?|$)/i.test(target) || /\/manifest/i.test(t.pathname);
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const cache = caches.default;

    // 分片走边缘长缓存；manifest 每次回源（可能更新）
    if (!isManifest) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const r = new Response(hit.body, hit);
        Object.entries(corsHeaders(request.headers.get('Origin'))).forEach(([k, v]) => r.headers.set(k, v));
        r.headers.set('X-Cache', 'HIT');
        return r;
      }
    }

    // 上游请求：伪装成从采集站自己的页面发起的正常浏览器请求
    const upstream = await fetch(target, {
      headers: {
        'User-Agent':
          request.headers.get('User-Agent') ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        // 这一行是防盗链的关键：伪装成从源站页面点进来的
        Referer: t.origin + '/',
        Origin: t.origin,
        Accept: '*/*',
        ...(request.headers.get('Range') ? { Range: request.headers.get('Range') } : {}),
      },
      redirect: 'follow',
    });

    const ct = upstream.headers.get('content-type') || '';

    // ---- manifest：重写后返回 ----
    if (isManifest || /mpegurl/i.test(ct)) {
      const text = await upstream.text();
      if (!text.startsWith('#EXTM3U')) {
        // 上游返回了错误页（403/404），原样抛出便于排查
        return new Response('上游未返回 m3u8（可能防盗链或资源已失效）\n\n' + text.slice(0, 300), {
          status: 502,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders('*') },
        });
      }
      return new Response(rewriteManifest(text, target, origin), {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'public, max-age=5',
          'X-Cache': 'MISS',
          ...corsHeaders(request.headers.get('Origin')),
        },
      });
    }

    // ---- 分片 / MP4：透传 + 边缘缓存 ----
    const headers = new Headers({
      'Content-Type': ct || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=604800, immutable',
      'X-Cache': 'MISS',
    });
    const cl = upstream.headers.get('content-length');
    const cr = upstream.headers.get('content-range');
    if (cl) headers.set('Content-Length', cl);
    if (cr) headers.set('Content-Range', cr);
    Object.entries(corsHeaders(request.headers.get('Origin'))).forEach(([k, v]) => headers.set(k, v));

    const out = new Response(upstream.body, { status: upstream.status, headers });

    // 只缓存完整 200（Range 请求不缓存，避免碎片污染缓存）
    // 用 waitUntil 让缓存写入在响应之后进行，不拖慢当前这个分片
    if (upstream.status === 200 && !request.headers.get('Range')) {
      const toCache = out.clone();
      try {
        if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(cacheKey, toCache));
        else await cache.put(cacheKey, toCache);
      } catch (e) {
        /* 缓存失败不影响播放 */
      }
    }
    return out;
  },
};
