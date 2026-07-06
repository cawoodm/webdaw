import puppeteer from 'puppeteer-core';

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: 'new',
  args: ['--autoplay-policy=user-gesture-required'],
});
await browser.defaultBrowserContext().overridePermissions('http://localhost:5199', []);
const page = await browser.newPage();

const consoleMsgs = [];
page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));

await page.evaluateOnNewDocument(() => {
  window.__audioCtxs = [];
  window.__ctxStacks = [];
  const Orig = window.AudioContext;
  window.AudioContext = class extends Orig {
    constructor(...args) {
      super(...args);
      window.__audioCtxs.push(this);
      window.__ctxStacks.push(new Error().stack);
    }
  };
});

await page.goto('http://localhost:5199', { waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 2000));

const beforeClick = await page.evaluate(() => ({
  contexts: window.__audioCtxs.length,
  states: window.__audioCtxs.map((c) => c.state),
  stacks: window.__ctxStacks,
}));

// trusted user gesture
await page.mouse.click(200, 400);
await new Promise((r) => setTimeout(r, 1500));

const afterClick = await page.evaluate(() => ({
  contexts: window.__audioCtxs.length,
  states: window.__audioCtxs.map((c) => c.state),
}));

// click the tone preview play button, wait, check context time is advancing (audio flowing)
const t1 = await page.evaluate(() => window.__audioCtxs[0]?.currentTime ?? -1);
await page.evaluate(() => {
  const btn = document.querySelector('.tone-transport button');
  btn?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  btn?.click();
});
await new Promise((r) => setTimeout(r, 1200));
const t2 = await page.evaluate(() => window.__audioCtxs[0]?.currentTime ?? -1);

console.log(JSON.stringify({ beforeClick, afterClick, currentTimeAdvancing: t2 > t1, t1, t2, consoleMsgs }, null, 2));
await browser.close();
