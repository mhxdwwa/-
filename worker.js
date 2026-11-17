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

/* 采集源自己写在清单里的广告标记。实测「量子」系会写：
     # ppvod-ad-injected v1
   有这行的话就是铁证，直接按它切。 */
const AD_MARKER = /(?:ad[-_\s]?inject|ppvod-ad|advert|guanggao|插入广告)/i;

/** 把媒体清单拆成「分片 + 它的标签行号」 */
function parseMediaPlaylist(text) {
  const lines = text.split(/\r?\n/);
  const segs = [];
  const adMarkers = [];
  let extinf = -1;
  let byterange = -1;
  let disc = -1;

  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    if (s.startsWith('#')) {
      // 非 EXT 标签的注释行，可能是源站标记的广告位
      if (!/^#EXT/i.test(s) && AD_MARKER.test(s)) adMarkers.push(i);
      if (s.startsWith('#EXTINF')) extinf = i;
      else if (s.startsWith('#EXT-X-BYTERANGE')) byterange = i;
      else if (s.startsWith('#EXT-X-DISCONTINUITY')) disc = i;
      else if (s.startsWith('#EXT-X-CUE-OUT')) disc = i; // SCTE-35 插播开头，按断点处理
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
  return { lines, segs, adMarkers };
}

function absHost(uri, baseUrl) {
  try {
    return new URL(uri, baseUrl).host;
  } catch (e) {
    return '';
  }
}

/** 分片所在的「目录根」= 路径前两段目录（不含文件名）。
 *  实测广告是别的一部片子的切片，目录根和正片完全不同：
 *    正片 /20261114/22052_d564e87a/2000k/hls/x.ts → 20261114/22052_d564e87a
 *    广告 /20261003/84_9109598f/2000k/hls/x.ts   → 20261003/84_9109598f
 *  目录层级不足两段时取实际目录，避免把文件名也当成根。 */
function pathRoot(uri, baseUrl) {
  try {
    const parts = new URL(uri, baseUrl).pathname.split('/').filter(Boolean);
    const dirs = parts.slice(0, -1);
    if (!dirs.length) return '';
    return dirs.slice(0, Math.min(2, dirs.length)).join('/');
  } catch (e) {
    return '';
  }
}

/** 标记可疑分片，返回被标记的分片索引集合 */
function markAds(segs, baseUrl, adMarkers) {
  const hostCount = {};
  segs.forEach((s) => {
    const h = absHost(s.uri, baseUrl);
    if (h) hostCount[h] = (hostCount[h] || 0) + 1;
  });
  const hosts = Object.keys(hostCount).sort((a, b) => hostCount[b] - hostCount[a]);
  const dominant = hosts[0] || '';

  // 少于 8 段时不做统计类判断 —— 短片源经常把首尾段放另一个域名，容易误伤
  const big = segs.length >= 8;

  // 规则 a：域名异常（少数派域名）
  if (big) {
    const lim = Math.max(3, hostCount[dominant] * 0.15);
    segs.forEach((s) => {
      const h = absHost(s.uri, baseUrl);
      if (h && h !== dominant && hostCount[h] <= lim) s.reasons.push('host:' + h);
    });
  }

  /* 规则 a2：目录根异常 —— 实测最有效的一条。
     广告是把另一部片子的切片直接塞进来，域名还是同一个，但目录根完全不同：
       正片  /20261114/22052_d564e87a/2000k/hls/xxx.ts
       广告  /20261003/84_9109598f/2000k/hls/xxx.ts
     同域所以规则 a 抓不到，必须比路径前两段。 */
  const rootCount = {};
  segs.forEach((s) => {
    const r = pathRoot(s.uri, baseUrl);
    if (r) rootCount[r] = (rootCount[r] || 0) + 1;
  });
  const rootKeys = Object.keys(rootCount).sort((a, b) => rootCount[b] - rootCount[a]);
  const domRoot = rootKeys[0] || '';
  // 根目录太碎就说明这个源的路径没有规律，别用这条规则，免得全判成广告
  const rootLim = Math.max(3, (rootCount[domRoot] || 0) * 0.15);
  if (big && rootKeys.length > 1 && rootKeys.length <= segs.length * 0.3) {
    segs.forEach((s) => {
      const r = pathRoot(s.uri, baseUrl);
      if (r && r !== domRoot && rootCount[r] <= rootLim) s.reasons.push('root:' + r);
    });
  }

  // 规则 b：路径关键词
  segs.forEach((s) => {
    if (AD_TOKENS.test(s.uri)) s.reasons.push('token');
  });

  // 规则 c：断点分组（#EXT-X-DISCONTINUITY / #EXT-X-CUE-OUT 都算断点）
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
  const runOfSeg = (idx) => {
    for (let i = 0; i < runs.length; i++) if (idx >= runs[i].start && idx <= runs[i].end) return i;
    return -1;
  };

  // 规则 d：源站自己写的广告标记（最硬的证据，看到就切）
  const markedRuns = new Set();
  (adMarkers || []).forEach((ln) => {
    const first = segs.findIndex((s) => s.line > ln);
    if (first < 0) return;
    const ri = runOfSeg(first);
    if (ri < 0) return;
    if (runs[ri].count > 40) return; // 太长的组不当作广告，防误杀
    markedRuns.add(ri);
  });

  // 候选岛：中段、5~45 秒、不超过 12 段
  const cand = [];
  runs.forEach((r, ri) => {
    if (ri === 0 || ri === runs.length - 1) return; // 首尾不算，避免误伤片头片尾
    if (r.dur < 5 || r.dur > 45) return;
    if (r.count > 12) return;
    cand.push(r);
  });

  // 正片分片时长的中位数。广告是另一次转码，段长常常和正片对不上
  const durs = segs.map((s) => s.dur).filter((d) => d > 0).sort((x, y) => x - y);
  const median = durs.length ? durs[Math.floor(durs.length / 2)] : 0;

  /* 广告位置随机（第 5 分钟、快结束、中间不定时），不能靠"重复出现"确认，
     所以单个岛必须自己站得住脚，满足任意一条才算：
       甲. 源站自己写了广告标记
       乙. 岛内有分片被域名/目录根/关键词规则盯上
       丙. 岛内平均段长和正片中位数差 35% 以上
       丁. 清单里还有别的时长相近的岛
     只有 confirmed 的组会被真正删除；reasons 里其余标记只用于体检展示。 */
  const confirmed = new Set();
  cand.forEach((r, i) => {
    if (markedRuns.has(runOfSeg(r.start))) {
      confirmed.add(i);
      return;
    }
    let hit = false;
    for (let k = r.start; k <= r.end && !hit; k++) if (segs[k].reasons.length) hit = true;
    if (hit) {
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

  segs.forEach((s) => { s.ad = false });
  let adCount = 0;
  confirmed.forEach((i) => {
    const r = cand[i];
    for (let k = r.start; k <= r.end; k++) {
      segs[k].ad = true;
      adCount++;
      if (segs[k].reasons.indexOf('island') < 0) segs[k].reasons.push('island');
    }
  });

  // 路径里明写 ad/gg/guanggao 的，证据足够硬，不需要断点包围也直接删
  segs.forEach((s) => {
    if (!s.ad && s.reasons.indexOf('token') >= 0) { s.ad = true; adCount++; }
  });

  return {
    hosts,
    hostCount,
    dominant,
    rootCount,
    domRoot,
    runs,
    islands: cand,
    markedRuns: markedRuns.size,
    confirmed: confirmed.size,
    adCount,
    medianSegDur: median,
  };
}

/** 从清单里删掉被判定为广告的分片（只看 s.ad，reasons 里的其余标记不动手）。
 *  只删 EXTINF / BYTERANGE / URI 三行，其余标签（KEY、MAP、DISCONTINUITY）原样保留。 */
function stripAdSegments(playlist) {
  const { lines, segs } = playlist;
  const drop = new Set();
  let removed = 0;
  segs.forEach((s) => {
    if (!s.ad) return;
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
   Worker 自带的体检页面：打开域名根路径就是一个输入框，
   粘 m3u8 地址点一下就出结果。不用改站点、不用手动编码。
   ========================================================= */
const UI_HTML = [
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>闯哥影视 · 广告体检</title><style>',
  '*{box-sizing:border-box}body{margin:0;padding:24px;font:15px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1c2024}',
  '.wrap{max-width:860px;margin:0 auto}h1{font-size:19px;margin:0 0 4px}p.sub{margin:0 0 18px;color:#6b7280;font-size:13px}',
  'textarea{width:100%;height:76px;padding:11px 13px;border:1px solid #d6dae0;border-radius:10px;font:13px/1.5 ui-monospace,Consolas,monospace;resize:vertical;background:#fff}',
  'textarea:focus{outline:none;border-color:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.12)}',
  'button{margin-top:10px;height:38px;padding:0 20px;border:0;border-radius:9px;background:#1c2024;color:#fff;font-size:14px;font-weight:600;cursor:pointer}',
  'button:disabled{opacity:.5;cursor:default}',
  '.card{background:#fff;border:1px solid #e5e8ec;border-radius:12px;padding:16px 18px;margin-top:16px}',
  '.verdict{font-weight:700;font-size:15px}.ok{color:#0f7b4f}.warn{color:#b4530a}.bad{color:#c03028}',
  '.kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-top:14px}',
  '.kv div{background:#f8f9fb;border-radius:8px;padding:9px 11px}.kv b{display:block;font-size:17px}.kv span{color:#6b7280;font-size:12px}',
  'table{width:100%;border-collapse:collapse;margin-top:12px;font-size:12.5px}',
  'th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eef0f3;word-break:break-all}',
  'th{color:#6b7280;font-weight:600}code{background:#f1f3f6;padding:1px 5px;border-radius:4px;font-size:12px}',
  '.hint{margin-top:14px;font-size:12.5px;color:#6b7280;line-height:1.7}',
  '</style></head><body><div class="wrap">',
  '<h1>广告体检</h1>',
  '<p class="sub">把这一集的 m3u8 地址粘进来。地址从 F12 → Network 里筛 <code>m3u8</code> 拿，或者直接看控制台打印的 <code>[播放源]</code>。</p>',
  '<textarea id="u" placeholder="https://xxx.com/20250101/abcd/index.m3u8"></textarea>',
  '<button id="go">开始体检</button>',
  '<div id="out"></div>',
  '<div class="hint">判定依据：广告是拿另一部片子的切片塞进来的，所以「目录根」和正片不同（同一域名也一样），另外还看路径关键词、源站自写的广告标记。<br>清单里连断点都没有 → 广告是转码进正片分片的，删不掉，只能换线路或跳过。</div>',
  '</div><script>',
  'var out=document.getElementById("out"),go=document.getElementById("go");',
  'function esc(s){return String(s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]})}',
  'function row(s){return "<tr><td>"+s.index+"</td><td>"+s.dur+"s</td><td>"+esc(s.uri).slice(0,90)+"</td><td>"+esc(s.reasons.join(", "))+"</td></tr>"}',
  'go.onclick=function(){',
  '  var u=document.getElementById("u").value.trim();',
  '  if(!u)return;',
  '  go.disabled=true;out.innerHTML="<div class=\\"card\\">正在拉取清单…</div>";',
  '  fetch("/inspect?u="+encodeURIComponent(u)).then(function(r){return r.json()}).then(function(d){',
  '    go.disabled=false;',
  '    if(d.kind==="master"){out.innerHTML="<div class=\\"card\\"><div class=\\"verdict warn\\">这是多码率主清单</div><p class=\\"sub\\" style=\\"margin:8px 0 0\\">广告不在主清单里。把下面的子清单地址再查一次：</p><code>"+esc(d.variants&&d.variants[0]?d.variants[0]:"见 /inspect 原始返回")+"</code></div>";return}',
  '    if(d.error){out.innerHTML="<div class=\\"card\\"><div class=\\"verdict bad\\">上游没返回 m3u8</div><p class=\\"sub\\" style=\\"margin:8px 0 0\\">"+esc(d.error)+"</p></div>";return}',
  '    var cls=d.suspectCount?"warn":"ok";',
  '    var h="<div class=\\"card\\"><div class=\\"verdict "+cls+"\\">"+esc(d.verdict)+"</div>";',
  '    h+="<div class=\\"kv\\"><div><b>"+d.segments+"</b><span>分片数</span></div><div><b>"+d.totalDuration+"s</b><span>总时长</span></div><div><b>"+d.discontinuities+"</b><span>断点数</span></div><div><b>"+d.medianSegDur+"s</b><span>正片段长中位数</span></div><div><b>"+d.suspectCount+"</b><span>可疑分片</span></div></div>";',
  '    if(d.hosts){var hs=Object.keys(d.hosts).map(function(k){return "<code>"+esc(k)+"</code> ×"+d.hosts[k]}).join("　");h+="<p class=\\"hint\\" style=\\"margin-top:12px\\">域名分布："+hs+"</p>"}',
  '    if(d.pathRoots&&Object.keys(d.pathRoots).length>1){var rs=Object.keys(d.pathRoots).map(function(k){return "<code>"+esc(k)+"</code> ×"+d.pathRoots[k]}).join("　");h+="<p class=\\"hint\\" style=\\"margin-top:6px\\">目录根分布："+rs+"</p>"}',
  '    if(d.suspects&&d.suspects.length){h+="<table><tr><th>#</th><th>时长</th><th>地址</th><th>可疑原因</th></tr>"+d.suspects.map(row).join("")+"</table>"}',
  '    out.innerHTML=h+"</div>";',
  '  }).catch(function(e){go.disabled=false;out.innerHTML="<div class=\\"card\\"><div class=\\"verdict bad\\">请求失败</div><p class=\\"sub\\">"+esc(e.message)+"</p></div>"});',
  '};',
  '</script></body></html>',
].join('\n');

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

    if (url.pathname === '/' || url.pathname === '/ui') {
      return new Response(UI_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    if (url.pathname === '/health') {
      return new Response(
        [
          'ok · 闯哥影视中转已就绪',
          '',
          '/                       体检页面（粘 m3u8 就能看广告能不能删）',
          '/p?u=<encodeURIComponent(源地址)>      播放与分片转发',
          '/inspect?u=<encodeURIComponent(m3u8)>  清单体检（JSON）',
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
      let inspectTarget = target;
      let up = await fetchUpstream(inspectTarget, request);
      let text = await up.text();
      if (!text.startsWith('#EXTM3U')) {
        return new Response(
          JSON.stringify({ error: '上游未返回 m3u8', status: up.status, head: text.slice(0, 200) }, null, 2),
          { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders('*') } }
        );
      }

      const variantsOf = () =>
        text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'))
          .map((l) => {
            try {
              return new URL(l, inspectTarget).href;
            } catch (e) {
              return l;
            }
          });

      // 粘进来的是主清单就自动跟到第一条子清单，省得用户再转一手
      if (isMaster(text)) {
        const first = variantsOf()[0];
        if (first) {
          inspectTarget = first;
          up = await fetchUpstream(first, request);
          text = await up.text();
        }
      }
      if (isMaster(text) || !text.startsWith('#EXTM3U')) {
        return new Response(
          JSON.stringify(
            {
              kind: 'master',
              variants: variantsOf().slice(0, 12),
              note: '连子清单都没拿到，把下面任意一条地址单独粘进来再查。',
            },
            null,
            2
          ),
          { headers: { 'Content-Type': 'application/json', ...corsHeaders('*') } }
        );
      }
      const pl = parseMediaPlaylist(text);
      const info = markAds(pl.segs, inspectTarget, pl.adMarkers);
      const suspects = pl.segs
        .map((s, i) => ({ index: i, dur: s.dur, uri: s.uri, reasons: s.reasons }))
        .filter((s) => s.reasons.length)
        .slice(0, 80);
      const total = pl.segs.reduce((a, s) => a + s.dur, 0);
      const out = {
        kind: 'media',
        picked: inspectTarget !== target ? inspectTarget : undefined,
        segments: pl.segs.length,
        totalDuration: Math.round(total),
        discontinuities: pl.segs.filter((s) => s.discLine >= 0).length,
        hosts: info.hostCount,
        dominantHost: info.dominant,
        pathRoots: info.rootCount,
        dominantRoot: info.domRoot,
        adMarkers: pl.adMarkers.length,
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
            : info.runs.length <= 1
              ? '清单里连断点都没有 —— 这个源没在清单层面插广告；如果你确实看到广告，那是转码进正片分片里的，删不掉'
              : '有断点，但没有一组的特征像广告 —— 广告很可能是转码进正片分片里的，删不掉',
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
        markAds(pl.segs, target, pl.adMarkers);
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
