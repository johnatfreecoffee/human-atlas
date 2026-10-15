import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('..', import.meta.url));
const publicDir = `${root}/public`;
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const port = 9334;
const preview = process.env.CAPTURE_URL ?? 'http://127.0.0.1:3016/?capture=1';

function launchChrome() {
  return spawn(chrome, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--user-data-dir=/tmp/ha-chrome-capture',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--force-color-profile=srgb',
    'about:blank',
  ], {stdio: 'ignore'});
}

async function browserWs() {
  for (let i = 0; i < 50; i++) {
    try {
      const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(r => r.json());
      return version.webSocketDebuggerUrl;
    } catch {
      await delay(200);
    }
  }
  throw new Error('Chrome DevTools did not come up');
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const {resolve, reject} = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, {resolve, reject});
    const payload = {id: msgId, method, params};
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
  });
  return send;
}

async function shoot() {
  const chromeProc = launchChrome();
  try {
    const ws = new WebSocket(await browserWs());
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    const send = cdp(ws);
    const {targetId} = await send('Target.createTarget', {url: 'about:blank'});
    const {sessionId} = await send('Target.attachToTarget', {targetId, flatten: true});
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1000,
      height: 1400,
      deviceScaleFactor: 2,
      mobile: false,
    }, sessionId);
    await send('Page.navigate', {url: preview}, sessionId);
    const started = Date.now();
    let ready = false;
    while (Date.now() - started < 90000) {
      const result = await send('Runtime.evaluate', {
        expression: 'document.documentElement.dataset.atlasReady==="1"',
        returnByValue: true,
      }, sessionId);
      if (result.result?.value) {ready = true; break;}
      await delay(400);
    }
    if (!ready) throw new Error('Anatomy did not finish rendering');
    await delay(700);
    const shot = await send('Page.captureScreenshot', {format: 'png'}, sessionId);
    ws.close();
    return Buffer.from(shot.data, 'base64');
  } finally {
    chromeProc.kill('SIGKILL');
  }
}

function contentBox(data, width, height, channels, isBody, y0 = 0, y1 = height) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      if (!isBody(r, g, b, max, min)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) throw new Error('No subject pixels found');
  return {x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1};
}

function ico(images) {
  const count = images.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);
  let offset = header.length;
  const parts = [header];
  images.forEach((image, index) => {
    const at = 6 + index * 16;
    header.writeUInt8(image.size >= 256 ? 0 : image.size, at);
    header.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(image.png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += image.png.length;
    parts.push(image.png);
  });
  return Buffer.concat(parts);
}

async function framed(source, box, size, {padTop = 0.08, padBottom = 0.12, padX = 0.1} = {}) {
  const meta = await sharp(source).metadata();
  const framedW = box.w * (1 + padX * 2);
  const framedH = box.h * (1 + padTop + padBottom);
  const side = Math.max(1, Math.round(Math.max(framedW, framedH)));
  const cx = box.x + box.w / 2;
  const top = box.y - box.h * padTop;
  const left = Math.round(cx - side / 2);
  const topPx = Math.round(top + framedH / 2 - side / 2);
  const srcLeft = Math.max(0, left);
  const srcTop = Math.max(0, topPx);
  const srcRight = Math.min(meta.width, left + side);
  const srcBottom = Math.min(meta.height, topPx + side);
  const piece = await sharp(source).extract({left: srcLeft, top: srcTop, width: srcRight - srcLeft, height: srcBottom - srcTop}).png().toBuffer();
  const canvas = await sharp({create: {width: side, height: side, channels: 3, background: '#ffffff'}})
    .composite([{input: piece, left: srcLeft - left, top: srcTop - topPx}])
    .png()
    .toBuffer();
  return sharp(canvas).resize(size, size, {fit: 'fill', kernel: 'lanczos3'}).flatten({background: '#ffffff'}).png().toBuffer();
}

const raw = process.env.CAPTURE_FILE ? readFileSync(process.env.CAPTURE_FILE) : await shoot();
if (!process.env.CAPTURE_FILE) writeFileSync('/tmp/ha-capture.png', raw);
const {data, info} = await sharp(raw).ensureAlpha().raw().toBuffer({resolveWithObject: true});
const {width, height, channels} = info;
const corner = [data[0], data[1], data[2]];
console.log('capture', width, height, 'corner', corner.join(','));
const body = contentBox(data, width, height, channels, (_r, _g, _b, max, min) => max - min > 14 || min < 210);
console.log('body', body);

const full = await framed(raw, body, 1024, {padTop: 0.055, padBottom: 0.09, padX: 0.08});
const mask = await framed(raw, body, 1024, {padTop: 0.16, padBottom: 0.2, padX: 0.18});
const torso = contentBox(data, width, height, channels, (_r, _g, _b, max, min) => max - min > 14 || min < 210, body.y, body.y + Math.round(body.h * 0.3));
console.log('torso', torso);
const bust = await framed(raw, torso, 256, {padTop: 0.07, padBottom: 0.07, padX: 0.07});

async function sized(input, size, sharpen) {
  let image = sharp(input).resize(size, size, {kernel: 'lanczos3'}).flatten({background: '#ffffff'});
  if (sharpen) image = image.sharpen(sharpen);
  return image.png().toBuffer();
}

const icon512 = await sized(full, 512);
const icon192 = await sized(full, 192);
const touch = await sized(full, 180);
const mask512 = await sized(mask, 512);
const mask192 = await sized(mask, 192);
const fav32 = await sized(bust, 32, {sigma: 0.45, m1: 0.6, m2: 0.25});
const fav16 = await sized(bust, 16, {sigma: 0.35, m1: 0.5, m2: 0.2});

writeFileSync(`${publicDir}/icon-512.png`, icon512);
writeFileSync(`${publicDir}/icon-192.png`, icon192);
writeFileSync(`${publicDir}/apple-touch-icon.png`, touch);
writeFileSync(`${publicDir}/icon-maskable-512.png`, mask512);
writeFileSync(`${publicDir}/icon-maskable-192.png`, mask192);
writeFileSync(`${publicDir}/favicon-32x32.png`, fav32);
writeFileSync(`${publicDir}/favicon-16x16.png`, fav16);
writeFileSync(`${publicDir}/favicon.ico`, ico([{size: 16, png: fav16}, {size: 32, png: fav32}]));
writeFileSync('/tmp/ha-bust.png', bust);
writeFileSync('/tmp/ha-full.png', full);

const portraitLeft = Math.max(0, Math.round(body.x - body.w * 0.08));
const portraitTop = Math.max(0, Math.round(body.y - body.h * 0.035));
const portraitRight = Math.min(width, Math.round(body.x + body.w * 1.08));
const portraitBottom = Math.min(height, Math.round(body.y + body.h * 1.07));
const portrait = await sharp(raw).extract({
  left: portraitLeft,
  top: portraitTop,
  width: portraitRight - portraitLeft,
  height: portraitBottom - portraitTop,
}).png().toBuffer();
const figure = await sharp(portrait).resize({height: 588, kernel: 'lanczos3'}).png().toBuffer();
const figureMeta = await sharp(figure).metadata();
const titleWidth = 452;
const gap = 112;
const titleX = Math.round((1200 - (titleWidth + gap + figureMeta.width)) / 2);
const title = Buffer.from(`<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#ffffff"/>
  <text x="${titleX}" y="338" fill="#20242b" font-family="Helvetica Neue, Helvetica, Arial, sans-serif" font-size="80" font-weight="600" letter-spacing="-1.8">Human Atlas</text>
</svg>`);
const og = await sharp({create: {width: 1200, height: 630, channels: 3, background: '#ffffff'}})
  .composite([
    {input: title, top: 0, left: 0},
    {input: figure, top: Math.round((630 - figureMeta.height) / 2), left: titleX + titleWidth + gap},
  ])
  .flatten({background: '#ffffff'})
  .removeAlpha()
  .png()
  .toBuffer();
writeFileSync(`${publicDir}/og-image.png`, og);
console.log('wrote icons', {figure: `${figureMeta.width}x${figureMeta.height}`});
