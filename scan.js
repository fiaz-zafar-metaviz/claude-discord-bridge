// Playwright page-section scanner
// Usage: node scan.js <url> <output-dir>
// Outputs JSON to stdout: {sections: [{path, label}]}

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const url = process.argv[2];
const outDir = process.argv[3] || '/tmp/scan';

if (!url) {
  console.error('usage: node scan.js <url> <out-dir>');
  process.exit(1);
}

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
});
const page = await ctx.newPage();

try {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
} catch (e) {
  console.error(`page load issue: ${e.message}`);
}

await page.waitForTimeout(2000);

// Try to detect semantic sections first; fallback to viewport-chunks
const sections = await page.evaluate(() => {
  const candidates = [];
  const tags = ['header', 'main > section', 'main > div', 'section', 'footer'];
  for (const sel of tags) {
    document.querySelectorAll(sel).forEach((el) => {
      const rect = el.getBoundingClientRect();
      const absTop = rect.top + window.scrollY;
      if (rect.height < 100) return;
      candidates.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        className: (el.className || '').toString().slice(0, 60),
        top: absTop,
        height: rect.height,
        text: (el.innerText || '').trim().slice(0, 80).replace(/\s+/g, ' '),
      });
    });
    if (candidates.length > 0) break;
  }
  // Dedup by top position
  const seen = new Set();
  return candidates.filter((c) => {
    const key = Math.round(c.top / 50);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
});

const result = { sections: [] };
const baseName = url.replace(/[^a-z0-9]/gi, '-').slice(0, 40);

if (sections.length >= 2 && sections.length <= 12) {
  // Screenshot each detected section
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    await page.evaluate((y) => window.scrollTo(0, y - 20), s.top);
    await page.waitForTimeout(500);
    const filePath = path.join(outDir, `${baseName}-section-${i + 1}.png`);
    try {
      await page.screenshot({ path: filePath, fullPage: false });
      result.sections.push({
        path: filePath,
        label: `Section ${i + 1}: ${s.tag}${s.id ? '#' + s.id : ''} - ${s.text || '(no text)'}`,
        text: s.text,
      });
    } catch (e) {
      console.error(`screenshot fail at ${i}: ${e.message}`);
    }
  }
} else {
  // Fallback: scroll in viewport-chunks
  const totalHeight = await page.evaluate(() => document.body.scrollHeight);
  const viewportH = 800;
  const chunks = Math.min(8, Math.ceil(totalHeight / viewportH));
  for (let i = 0; i < chunks; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), i * viewportH);
    await page.waitForTimeout(500);
    const filePath = path.join(outDir, `${baseName}-chunk-${i + 1}.png`);
    try {
      await page.screenshot({ path: filePath, fullPage: false });
      result.sections.push({
        path: filePath,
        label: `Chunk ${i + 1} of ${chunks}`,
      });
    } catch (e) {
      console.error(`screenshot fail at ${i}: ${e.message}`);
    }
  }
}

await browser.close();
console.log(JSON.stringify(result));
