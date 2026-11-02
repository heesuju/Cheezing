// Candidate URLs for the full-size original of an image, built from the URL
// the page shows. Many sites serve a resized copy whose original is one URL
// change away (a size parameter, a "-300x200" suffix, a /thumb/ path). These
// are only guesses: the background fetches each one and keeps it only if
// it is an image with more pixels than the page's own (see background.js).
//
// Each candidate is { url, strict }. A strict candidate comes from a
// generic rule, so it must also keep the page image's aspect ratio (a
// broader guess could land on a different picture); a site rule's
// candidate may differ, since sites crop thumbnails.
const SIZE_PARAMS = ['w', 'h', 'width', 'height', 'resize', 'fit', 'crop', 'dpr', 'quality',
  'maxwidth', 'maxheight', 'mw', 'mh', 'size', 'scale', 'thumbnail', 'thumb'];
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const MAX_ORIGINAL_CANDIDATES = 6;

function originalCandidates(pageUrl, linkUrl) {
  const out = [];
  const add = (url, strict = false) => {
    if (!url || url === pageUrl || out.some((c) => c.url === url)) return;
    out.push({ url, strict });
  };

  // A link around the image to an image file: what a lightbox opens
  if (linkUrl) {
    add(linkUrl);
    const link = parseUrl(linkUrl);
    if (link) for (const url of siteRules(link)) add(url);
  }

  const u = parseUrl(pageUrl);
  if (!u) return out.slice(0, MAX_ORIGINAL_CANDIDATES);
  const known = siteRules(u);
  for (const url of known) add(url);
  // A site with its own rule isn't second-guessed with broad edits
  if (known.length === 0) for (const url of genericRules(u)) add(url, true);
  return out.slice(0, MAX_ORIGINAL_CANDIDATES);
}

function parseUrl(raw) {
  try {
    const u = new URL(raw);
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch (err) {
    return null;
  }
}

// Returns a copy of `u` changed by fn(copy), as a string
function edited(u, fn) {
  const copy = new URL(u.href);
  fn(copy);
  return copy.href;
}

function hostIs(u, ...domains) {
  return domains.some((d) => u.hostname === d || u.hostname.endsWith('.' + d));
}

function siteRules(u) {
  const out = [];
  const path = u.pathname;

  // Naver (blogs, cafes, news): ?type=w773 / w80_blur picks a resized copy.
  // Checked against live posts: blogfiles. serves the uploaded file as is,
  // and type=w3840 the largest copy (capped at the original's size). With
  // no type at all postfiles. gives a 100px thumbnail -- but profile
  // pictures (blogpfthumb-phinf.) give their original that way.
  if (hostIs(u, 'pstatic.net') && u.searchParams.has('type')) {
    if (u.hostname === 'postfiles.pstatic.net') {
      out.push(edited(u, (c) => { c.hostname = 'blogfiles.pstatic.net'; c.search = ''; }));
    }
    out.push(edited(u, (c) => c.searchParams.set('type', 'w3840')));
    out.push(edited(u, (c) => c.searchParams.delete('type')));
  }
  // Naver's thumbnail proxy for outside images: ?src="<original URL>"
  if ((u.hostname === 'dthumb-phinf.pstatic.net' || u.hostname === 'search.pstatic.net') && u.searchParams.get('src')) {
    const inner = parseUrl(u.searchParams.get('src').replace(/^"|"$/g, ''));
    if (inner) out.push(inner.href, ...siteRules(inner));
  }

  // Daum / Tistory thumbnails wrap the original's URL in ?fname=
  if (hostIs(u, 'daumcdn.net') && u.searchParams.get('fname')) {
    const inner = parseUrl(u.searchParams.get('fname'));
    if (inner) {
      out.push(inner.href);
      if (hostIs(inner, 'kakaocdn.net') && !inner.search) out.push(inner.href + '?original');
    }
  }
  // Tistory / Kakao: ?original asks for the uploaded file
  if (hostIs(u, 'kakaocdn.net') && !u.searchParams.has('original')) {
    out.push(edited(u, (c) => { c.search = '?original'; }));
  }

  // X / Twitter: ?name=small|medium|large|900x900 -> orig, or legacy :large
  if (hostIs(u, 'twimg.com')) {
    if (u.searchParams.has('name')) out.push(edited(u, (c) => c.searchParams.set('name', 'orig')));
    if (/:(small|medium|large|thumb)$/.test(path)) out.push(edited(u, (c) => { c.pathname = path.replace(/:\w+$/, ':orig'); }));
    if (/\.(jpe?g|png|webp)$/.test(path) && !u.searchParams.has('name')) out.push(edited(u, (c) => { c.search = '?name=orig'; }));
  }

  // Google (Blogger, Photos, YouTube avatars, Play): =s400, =w600-h400-c, /s400/
  if (hostIs(u, 'googleusercontent.com', 'ggpht.com', 'blogspot.com', 'bp.blogspot.com')) {
    if (/=[swh]\d+[^/]*$/.test(path)) out.push(edited(u, (c) => { c.pathname = path.replace(/=[swh]\d+[^/]*$/, '=s0'); }));
    if (/\/[swh]\d+(-[a-z0-9-]+)?\//.test(path)) out.push(edited(u, (c) => { c.pathname = path.replace(/\/[swh]\d+(-[a-z0-9-]+)?\//, '/s0/'); }));
  }

  // Pinterest: /236x/, /474x/, /736x/ -> /originals/
  if (hostIs(u, 'pinimg.com') && /^\/\d+x\d*\//.test(path)) {
    out.push(edited(u, (c) => { c.pathname = path.replace(/^\/\d+x\d*\//, '/originals/'); }));
  }

  // Reddit: preview.redd.it/<file>?width=... -> i.redd.it/<file>
  if (u.hostname === 'preview.redd.it') {
    out.push(`https://i.redd.it${path}`);
  }

  // Imgur: <id>_d.jpg?maxwidth=800&shape=thumb, or a 7-char id + size
  // letter (s, b, t, m, l, h) -> the id alone
  if (u.hostname === 'i.imgur.com') {
    const m = path.match(/^\/([a-zA-Z0-9]{5,7})(?:_[a-z]+|(?<=^\/[a-zA-Z0-9]{7})[sbtmlh])?(\.\w+)$/);
    if (m) out.push(`https://i.imgur.com/${m[1]}${m[2]}`);
  }

  // YouTube thumbnails: default / mqdefault / hqdefault / sddefault -> maxresdefault
  if (hostIs(u, 'ytimg.com') && /\/(default|mqdefault|hqdefault|sddefault|hq720)\.(jpg|webp)$/.test(path)) {
    out.push(edited(u, (c) => {
      c.pathname = path.replace(/\/\w+\.(jpg|webp)$/, '/maxresdefault.$1');
      c.search = '';
    }));
  }

  // Wikimedia (upload. or thumb.): /thumb/a/ab/File.jpg/220px-File.jpg -> /a/ab/File.jpg
  if ((u.hostname === 'upload.wikimedia.org' || u.hostname === 'thumb.wikimedia.org') && path.includes('/thumb/')) {
    const m = path.match(/^(.*)\/thumb\/(.+?)\/[^/]+$/);
    if (m) out.push(`https://upload.wikimedia.org${m[1]}/${m[2]}`);
  }

  // Amazon: name._AC_SX300_.jpg -> name.jpg
  if (hostIs(u, 'media-amazon.com', 'ssl-images-amazon.com', 'images-amazon.com') && /\._[^/]+_\.\w+$/.test(path)) {
    out.push(edited(u, (c) => { c.pathname = path.replace(/\._[^/]+_(\.\w+)$/, '$1'); }));
  }

  // Shopify: name_300x300.jpg, name_grande.jpg, ?width=600
  if (hostIs(u, 'shopify.com') || path.includes('/cdn/shop/')) {
    const stripped = path.replace(/_(\d+x\d*|\d*x\d+|pico|icon|thumb|small|compact|medium|large|grande|1024x1024|2048x2048|master)(@\dx)?(?=\.\w+$)/, '');
    out.push(edited(u, (c) => {
      c.pathname = stripped;
      for (const p of ['width', 'height', 'crop']) c.searchParams.delete(p);
    }));
  }

  // WordPress uploads: name-300x200.jpg and name-scaled.jpg -> name.jpg
  if (path.includes('/wp-content/uploads/')) {
    const base = path.replace(/-\d+x\d+(?=\.\w+$)/, '').replace(/-scaled(?=\.\w+$)/, '');
    out.push(edited(u, (c) => {
      c.pathname = base;
      for (const p of ['resize', 'fit', 'w', 'h', 'ssl']) c.searchParams.delete(p);
    }));
  }

  // Medium: /v2/resize:fit:700/<id> -> /v2/<id>
  if (u.hostname === 'miro.medium.com' && /\/resize:[^/]+/.test(path)) {
    out.push(edited(u, (c) => { c.pathname = path.replace(/\/resize:[^/]+/, ''); }));
  }

  // Unsplash, imgix-style CDNs: every query parameter is a transform
  if (hostIs(u, 'unsplash.com', 'imgix.net') && u.search) {
    out.push(edited(u, (c) => { c.search = ''; }));
  }

  // Flickr: id_secret_[sqtmnzcw].jpg -> _b (1024px, same secret)
  if (hostIs(u, 'staticflickr.com')) {
    const m = path.match(/^(.*\/\d+_[0-9a-f]+)(_[sqtmnzcw])?\.jpg$/);
    if (m) out.push(edited(u, (c) => { c.pathname = `${m[1]}_b.jpg`; }));
  }

  // Wix: /media/<file>/v1/fill/w_300,h_200,.../name.jpg -> /media/<file>
  if (u.hostname === 'static.wixstatic.com' && /^\/media\/[^/]+\/v1\//.test(path)) {
    out.push(edited(u, (c) => { c.pathname = path.replace(/^(\/media\/[^/]+)\/v1\/.*$/, '$1'); }));
  }

  // Squarespace: ?format=500w -> ?format=original
  if (hostIs(u, 'squarespace-cdn.com') ) {
    out.push(edited(u, (c) => c.searchParams.set('format', 'original')));
  }

  // Cloudinary: /image/upload/w_400,c_fill/v123/x.jpg -> /image/upload/v123/x.jpg
  if (hostIs(u, 'cloudinary.com') && /\/upload\//.test(path)) {
    const parts = path.split('/');
    const at = parts.indexOf('upload');
    let end = at + 1;
    while (end < parts.length - 1 && /^[a-z]{1,3}_[^/]*$/.test(parts[end]) ) end++;
    if (end > at + 1) out.push(edited(u, (c) => { c.pathname = [...parts.slice(0, at + 1), ...parts.slice(end)].join('/'); }));
  }

  // Next.js image optimizer: /_next/image?url=<original>&w=640&q=75
  if (path.endsWith('/_next/image') && u.searchParams.get('url')) {
    try {
      out.push(new URL(u.searchParams.get('url'), u.origin).href);
    } catch (err) { /* not a URL */ }
  }

  return out;
}

// Broader guesses for any site: drop size parameters from the query, or a
// thumbnail marker from the file name
// thumbnail marker from the path -- all at once first, then each alone
function genericRules(u) {
  const sizeKeys = [...u.searchParams.keys()].filter((k) => SIZE_PARAMS.includes(k.toLowerCase()) ||
    (k.toLowerCase() === 'q' && IMAGE_EXT.test(u.pathname)));
  const dropQuery = (c) => sizeKeys.forEach((k) => c.searchParams.delete(k));
  const pathEdits = [
    (p) => p.replace(/([_.-](thumb|thumbnail|small|medium|preview))(?=\.\w+$)/i, ''),
    (p) => p.replace(/-\d{2,4}x\d{2,4}(?=\.\w+$)/, ''),
    (p) => p.replace(/\/(thumbs?|thumbnails?|small|medium|resized?)\//i, '/')
  ].filter((fn) => fn(u.pathname) !== u.pathname);

  const out = [];
  if (sizeKeys.length + pathEdits.length > 1) {
    out.push(edited(u, (c) => {
      dropQuery(c);
      c.pathname = pathEdits.reduce((p, fn) => fn(p), c.pathname);
    }));
  }
  if (sizeKeys.length) out.push(edited(u, dropQuery));
  for (const fn of pathEdits) out.push(edited(u, (c) => { c.pathname = fn(c.pathname); }));
  return out;
}

if (typeof module !== 'undefined') module.exports = { originalCandidates };
