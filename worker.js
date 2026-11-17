/**
 * 闯哥影视 —— 视频中转 Worker（Cloudflare）
 *
 * 解决四件事：
 *   1. 补 CORS            采集站 m3u8 基本不带 Access-Control-Allow-Origin，hls.js 直连必被拦
 *   2. 伪装 Referer       多数采集站校验防盗链，头不对直接 403
 *   3. 重写 m3u8 全部 URI  只补头没用，分片地址也得走中转，否则分片照样被挡
 *   4. 剥离广告分片        5 分钟一次的固定贴片，如果是以独立分片插进清单的，可以无损剪掉
 *
 * 路由：
 *   /                   健康检查
 *   /p?u=<enc>          播放/分片转发（默认开启广告剥离，?ads=0 关闭）
 *   /inspect?u=<enc>    清单体检：把 m3u8 拆开看有多少段、几个域名、哪里有断点、哪些可疑
 *
 * 部署：
 *   A. wrangler deploy worker.js --name vrelay
 *   B. dash.cloudflare.com → Workers & Pages → Create → Worker → 粘贴 → Deploy
 */

// ============ 允许调用你的中转的来源（防白嫖流量）============
// 留空 [] = 不限制。上线建议填上：
//   const ALLOW_ORIGINS = ['https://mhxdwwa.github.io'];
const ALLOW_ORIGINS = [];

const CORS_BASE = {
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Expose-Headers':
    'Content-Length, Content-Range, Accept-Ranges, X-Cache, X-Ads-Removed',
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

/* =========================================================
   广告分片识别
   广告通常以「独立分片」形式插进 m3u8，特征是：
     a. 域名和正片分片不是同一个（广告走自己的 CDN）
     b. 路径里带 ad/gg/guanggao 之类的词
     c. 夹在两条 #EXT-X-DISCONTINUITY 之间的一小段（8~22 秒、不超过 4 段）
   三条命中任意一条即判为广告。全部用保守阈值，宁可漏杀也不误伤正片。
   ========================================================= */
const AD_TOKENS =
  /(?:^|[\/_\-.])(ad|ads|adv|advert|advideo|guanggao|gg|sponsor|preroll|midroll|postroll|commercial|spot|tuiguang|win|bet)(?:[\/_\-.]|$)/i;

/** 把媒体清单拆成「分片 + 它的标签行号」 */
function parseMediaPlaylist(text) {
  const lines = text.split(/\r?\n/);
  const segs = [];
  let extinf = -1;
  let byterange = -1;
  let disc = -1;

  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    if (s.startsWith('#')) {
      if (s.startsWith('#EXTINF')) extinf = i;
      else if (s.startsWith('#EXT-X-BYTERANGE')) byterange = i;
      else if (s.startsWith('#EXT-X-DISCONTINUITY')) disc = i;
      continue;
    }
    const dm = extinf >= 0 ? lines[extinf].match(/#EXTINF:\s*([\d.]+)/) : null;
    segs.push({
      line: i,
      uri: s,
      dur: dm ? parseFloat(dm[1]) : 0,
      extinfLine: extinf,
      brLine: byterange,
      discLine: disc,
      reasons: [],
    });
    extinf = -1;
    byterange = -1;
    disc = -1;
  }
  return { lines, segs };
}

function absHost(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).host;
  } catch (e) {
    return '';
  }
}

/** 标记可疑分片，返回被标记的分片索引集合 */
function markAds(segs, baseUrl) {
  const hostCount = {};
  segs.forEach((s) => {
    const h = absHost(s.uri, baseUrl);
    if (h) hostCount[h] = (hostCount[h] || 0) + 1;
  });
  const hosts = Object.keys(hostCount).sort((a, b) => hostCount[b] - hostCount[a]);
  const dominant = hosts[0] || '';

  // 规则 a：域名异常（少数派域名）
  // 少于 8 段时不做域名判断 —— 短片源经常把首尾段放另一个域名，容易误伤
  if (segs.length >= 8) {
    segs.forEach((s) => {
      const h = absHost(s.uri, baseUrl);
      if (h && h !== dominant && hostCount[h] <= Math.max(2, segs.length * 0.05)) {
        s.reasons.push('host:' + h);
      }
    });
  }

  // 规则 b：路径关键词
  segs.forEach((s) => {
    if (AD_TOKENS.test(s.uri)) s.reasons.push('token');
  });

  // 规则 c：夹在两条断点之间的短岛
  const runs = [];
  let cur = null;
  segs.forEach((s, idx) => {
    const isDisc = s.discLine >= 0;
    if (!cur || isDisc) {
      cur = { start: idx, count: 0, dur: 0, end: idx };
      runs.push(cur);
    }
    cur.count++;
    cur.dur += s.dur;
    cur.end = idx;
  });

  // 先挑出「中段 + 8~25 秒 + 不超过 6 段」的候选岛
  const cand = [];
  runs.forEach((r, ri) => {
    if (ri === 0 || ri === runs.length - 1) return; // 首尾不算，避免误伤片头片尾
    if (r.dur < 8 || r.dur > 25) return;
    if (r.count > 6) return;
    cand.push(r);
  });

  // 正片自己的分片时长中位数。广告是另一次转码，段长通常和正片不一样
  const durs = segs.map((s) => s.dur).filter((d) => d > 0).sort((x, y) => x - y);
  const median = durs.length ? durs[Math.floor(durs.length / 2)] : 0;

  /* 广告位置是随机的（第 5 分钟、快结束、中间不定时），不能靠"重复出现"来确认。
     所以单个岛必须自己站得住脚，满足任意一条才算广告：
       甲. 岛内分片所在域名/路径本身就可疑
       乙. 岛内平均段长和正片中位数差 35% 以上（另一次转码的铁证）
       丙. 清单里还有别的时长相近的岛（有规律更好，没有也不影响）           */
  const confirmed = new Set();
  cand.forEach((r, i) => {
    const first = segs[r.start];
    if (first.reasons.length) {
      confirmed.add(i);
      return;
    }
    const avg = r.dur / r.count;
    if (median > 0 && Math.abs(avg - median) > median * 0.35) {
      confirmed.add(i);
      return;
    }
    for (let j = 0; j < cand.length; j++) {
      if (j === i) continue;
      const o = cand[j].dur;
      if (Math.abs(o - r.dur) <= Math.max(2, Math.min(o, r.dur) * 0.3)) {
        confirmed.add(i);
        return;
      }
    }
  });

  confirmed.forEach((i) => {
    const r = cand[i];
    for (let k = r.start; k <= r.end; k++) {
      if (segs[k].reasons.indexOf('island') < 0) segs[k].reasons.push('island');
    }
  });

  return { hosts, hostCount, dominant, runs, islands: cand, confirmed: confirmed.size, medianSegDur: median };
}

/** 从清单里删掉被标记的分片。只删 EXTINF / BYTERANGE / URI 三行，
 *  其余标签（KEY、MAP、DISCONTINUITY）原样保留 —— 少删比错删安全。 */
function stripAdSegments(playlist) {
  const { lines, segs } = playlist;
  const drop = new Set();
  let removed = 0;
  segs.forEach((s) => {
    if (!s.reasons.length) return;
    removed++;
    drop.add(s.line);
    if (s.extinfLine >= 0) drop.add(s.extinfLine);
    if (s.brLine >= 0) drop.add(s.brLine);
  });
  if (!removed) return { text: lines.join('\n'), removed: 0 };
  const kept = lines.filter((_, i) => !drop.has(i));

  // 广告岛两头各有一条 #EXT-X-DISCONTINUITY，挖掉中间后会连着两条。
  // 连续两条断点会让 hls.js 打警告甚至报错，这里合并成一条。
  const out = [];
  let prevDisc = false;
  for (const line of kept) {
    const isDisc = line.trim() === '#EXT-X-DISCONTINUITY';
    if (isDisc && prevDisc) continue;
    prevDisc = isDisc;
    out.push(line);
  }
  return { text: out.join('\n'), removed };
}

/** 把 m3u8 里所有 URI 替换成走本 Worker 的地址 */
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
        // EXT-X-KEY（加密 key）、EXT-X-MAP（fMP4 init 段）、EXT-X-MEDIA（音轨）都要换
        return line.replace(/URI="([^"]+)"/g, (m, u) => 'URI="' + wrap(u) + '"');
      }
      return wrap(s);
    })
    .join('\n');
}

function isMaster(text) {
  return /#EXT-X-STREAM-INF/i.test(text);
}

/* =========================================================
   上游请求
   ========================================================= */
async function fetchUpstream(target, request) {
  const t = new URL(target);
  return fetch(target, {
    headers: {
      'User-Agent':
        request.headers.get('User-Agent') ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      Referer: t.origin + '/', // 防盗链关键：伪装成从源站页面点进来的
      Origin: t.origin,
      Accept: '*/*',
      ...(request.headers.get('Range') ? { Range: request.headers.get('Range') } : {}),
    },
    redirect: 'follow',
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = url.origin;
    const originHdr = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(originHdr) });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response(
        [
          'ok · 闯哥影视中转已就绪',
          '',
          '/p?u=<encodeURIComponent(源地址)>      播放与分片转发',
          '/inspect?u=<encodeURIComponent(m3u8)>  清单体检（看广告藏在哪）',
          '',
          '广告剥离默认开启，加 &ads=0 可关闭',
        ].join('\n'),
        { headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders('*') } }
      );
    }

    const isInspect = url.pathname === '/inspect';
    if (url.pathname !== '/p' && !isInspect) {
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

    const adsOn = url.searchParams.get('ads') !== '0';
    const looksManifest =
      /\.m3u8(\?|$)/i.test(target) || /m3u8/i.test(t.pathname) || isInspect;

    /* ---------------- 体检 ---------------- */
    if (isInspect) {
      const up = await fetchUpstream(target, request);
      const text = await up.text();
      if (!text.startsWith('#EXTM3U')) {
        return new Response(
          JSON.stringify({ error: '上游未返回 m3u8', status: up.status, head: text.slice(0, 200) }, null, 2),
          { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders('*') } }
        );
      }
      if (isMaster(text)) {
        return new Response(
          JSON.stringify(
            { kind: 'master', note: '这是多码率主清单，广告不在这里。请把其中一条子清单地址再 inspect 一次。' },
            null,
            2
          ),
          { headers: { 'Content-Type': 'application/json', ...corsHeaders('*') } }
        );
      }
      const pl = parseMediaPlaylist(text);
      const info = markAds(pl.segs, target);
      const suspects = pl.segs
        .map((s, i) => ({ index: i, dur: s.dur, uri: s.uri, reasons: s.reasons }))
        .filter((s) => s.reasons.length)
        .slice(0, 80);
      const total = pl.segs.reduce((a, s) => a + s.dur, 0);
      const out = {
        kind: 'media',
        segments: pl.segs.length,
        totalDuration: Math.round(total),
        discontinuities: pl.segs.filter((s) => s.discLine >= 0).length,
        hosts: info.hostCount,
        dominantHost: info.dominant,
        runs: info.runs.slice(0, 40).map((r) => ({
          from: r.start,
          to: r.end,
          count: r.count,
          duration: Math.round(r.dur * 10) / 10,
        })),
        islands: info.islands.map((r) => ({
          from: r.start,
          to: r.end,
          count: r.count,
          duration: Math.round(r.dur * 10) / 10,
        })),
        islandsConfirmed: info.confirmed,
        medianSegDur: info.medianSegDur,
        suspectCount: suspects.length,
        suspects,
        verdict:
          suspects.length > 0
            ? '有可疑分片，中转会自动剥掉（见 suspects）'
            : '清单里没有可疑分片 —— 广告很可能是把正片分片转码时拼进去的，删不掉，只能用跳过策略',
      };
      return new Response(JSON.stringify(out, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders('*') },
      });
    }

    /* ---------------- 分片 / MP4：透传 + 边缘缓存 ---------------- */
    const cacheKey = new Request(url.toString(), { method: 'GET' });
    const cache = caches.default;

    if (!looksManifest) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const r = new Response(hit.body, hit);
        Object.entries(corsHeaders(originHdr)).forEach(([k, v]) => r.headers.set(k, v));
        r.headers.set('X-Cache', 'HIT');
        return r;
      }
    }

    const upstream = await fetchUpstream(target, request);
    const ct = upstream.headers.get('content-type') || '';

    /* ---------------- manifest ---------------- */
    if (looksManifest || /mpegurl/i.test(ct)) {
      const text = await upstream.text();
      if (!text.startsWith('#EXTM3U')) {
        return new Response('上游未返回 m3u8（可能防盗链或资源已失效）\n\n' + text.slice(0, 300), {
          status: 502,
          headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders('*') },
        });
      }

      let adsRemoved = 0;
      let body = text;

      // 主清单不动广告，只重写；媒体清单先剥广告再重写
      if (!isMaster(text) && adsOn) {
        const pl = parseMediaPlaylist(text);
        markAds(pl.segs, target);
        const r = stripAdSegments(pl);
        body = r.text;
        adsRemoved = r.removed;
      }

      return new Response(rewriteManifest(body, target, origin), {
        status: 200,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'public, max-age=5',
          'X-Cache': 'MISS',
          'X-Ads-Removed': String(adsRemoved),
          ...corsHeaders(originHdr),
        },
      });
    }

    /* ---------------- 分片 / MP4 ---------------- */
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
    Object.entries(corsHeaders(originHdr)).forEach(([k, v]) => headers.set(k, v));

    const out = new Response(upstream.body, { status: upstream.status, headers });

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
