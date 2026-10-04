'use strict';

// Bump the version when releasing changes to any cached asset.
const CACHE_PREFIX = 'ipixelcolor-shell-';
const CACHE_NAME = CACHE_PREFIX + 'v2';
const base = new URL('./', self.location.href);
const assets = [
  'iPixelcolor.html',
  'index.html',
  'ipixel-protocol.js',
  'ipixelcolor.webmanifest',
  'fonts/unifont.woff2',
  'fonts/UNIFONT_LICENSE.txt',
  'icons/ipixelcolor-180.png',
  'icons/ipixelcolor-192.png',
  'icons/ipixelcolor-512.png',
  'icons/ipixelcolor-maskable-512.png'
].map(path => new URL(path, base).href);
// Code files are fetched network-first so updates land on the next online visit.
const fresh = new Set(['iPixelcolor.html', 'index.html', 'ipixel-protocol.js'].map(path => new URL(path, base).href));

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(assets)));
  // Updates wait for existing tabs to close, preserving active BLE sessions.
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  url.search = '';
  url.hash = '';
  if (url.href === base.href) url.pathname += 'index.html';
  // Only intercept this app's assets, even when hosted beside other pages.
  if (!assets.includes(url.href)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (fresh.has(url.href)) {
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          await cache.put(url.href, response.clone());
          return response;
        }
        return (await cache.match(url.href)) || response;
      } catch (error) {
        const cached = await cache.match(url.href);
        if (cached) return cached;
        throw error;
      }
    }
    const cached = await cache.match(url.href);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) await cache.put(url.href, response.clone());
    return response;
  })());
});
