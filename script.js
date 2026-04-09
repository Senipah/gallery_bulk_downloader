// ==UserScript==
// @name         Gallery Bulk Downloader
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Download image/video files from supported open lightbox overlays
// @match        *://*/*
// @grant        GM_download
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  'use strict';

  const BTN_ID = 'tm-gallery-download-btn';
  let stylesInjected = false;

  const IMAGE_EXTENSIONS = new Set([
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'tif', 'tiff', 'heic', 'heif'
  ]);
  const VIDEO_EXTENSIONS = new Set([
    'mp4', 'm4v', 'webm', 'mov', 'ogv', 'ogg', 'mkv', 'avi', 'wmv', 'mpeg', 'mpg', '3gp'
  ]);
  const EMBED_HOST_PATTERNS = [
    /(^|\.)youtube\.com$/i,
    /(^|\.)youtu\.be$/i,
    /(^|\.)vimeo\.com$/i,
    /(^|\.)dailymotion\.com$/i,
    /(^|\.)facebook\.com$/i,
    /(^|\.)instagram\.com$/i,
    /(^|\.)tiktok\.com$/i,
    /(^|\.)twitter\.com$/i,
    /(^|\.)x\.com$/i
  ];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function normalizeUrl(url) {
    if (!url) return null;

    try {
      const normalized = new URL(url, window.location.href);
      normalized.hash = '';
      return normalized.href;
    } catch (error) {
      return String(url).split('#')[0];
    }
  }

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;

    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function sanitizeFilename(name) {
    return String(name || '')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .trim();
  }

  function parseCounterText(text) {
    if (!text) return null;

    const str = String(text).trim();
    const match = str.match(/(\d+)\s*(?:\/|of)\s*(\d+)/i);
    if (!match) return null;

    const current = Number(match[1]);
    const total = Number(match[2]);
    if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return null;

    return {
      index: Math.max(0, current - 1),
      total
    };
  }

  function getMediaUrlFromElement(el) {
    if (!el) return null;

    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'img') {
      return el.currentSrc || el.src || el.getAttribute('src') || null;
    }

    if (tag === 'video') {
      const direct = el.currentSrc || el.src || el.getAttribute('src');
      if (direct) return direct;

      const source = el.querySelector('source[src]');
      return source ? (source.src || source.getAttribute('src')) : null;
    }

    if (tag === 'source') {
      return el.src || el.getAttribute('src') || null;
    }

    return null;
  }

  function inferMediaTypeFromUrl(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return 'unsupported';
    if (/^(blob:|data:)/i.test(normalized)) return 'unsupported';

    try {
      const parsed = new URL(normalized);
      const match = parsed.pathname.toLowerCase().match(/\.([a-z0-9]+)$/i);
      if (!match) return 'unsupported';

      const ext = match[1];
      if (IMAGE_EXTENSIONS.has(ext)) return 'image';
      if (VIDEO_EXTENSIONS.has(ext)) return 'video';
      return 'unsupported';
    } catch (error) {
      return 'unsupported';
    }
  }

  function isLikelyEmbedUrl(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return false;

    try {
      const parsed = new URL(normalized);
      const protocol = parsed.protocol.toLowerCase();
      if (protocol !== 'http:' && protocol !== 'https:') return true;

      const host = parsed.hostname.toLowerCase();
      if (EMBED_HOST_PATTERNS.some((pattern) => pattern.test(host))) return true;

      const path = `${parsed.pathname}${parsed.search}`.toLowerCase();
      return path.includes('/embed/') || path.includes('youtube.com/watch') || path.includes('player.');
    } catch (error) {
      return false;
    }
  }

  function getHintedMediaTypeFromText(value) {
    if (!value) return null;
    const str = String(value).toLowerCase();

    if (/iframe|html|inline|ajax|youtube|vimeo|map/.test(str)) return 'unsupported';
    if (/video|mp4|webm|mov|m3u8|dash/.test(str)) return 'video';
    if (/image|photo|jpg|jpeg|png|gif|webp|avif|svg/.test(str)) return 'image';
    return null;
  }

  function getHintedMediaTypeFromElement(el) {
    if (!el) return null;

    const hints = [
      el.getAttribute('data-type'),
      el.getAttribute('type'),
      el.getAttribute('data-glightbox'),
      el.getAttribute('class')
    ];

    for (const hint of hints) {
      const mediaType = getHintedMediaTypeFromText(hint);
      if (mediaType) return mediaType;
    }

    return null;
  }

  function resolveMediaType(url, hintedType) {
    const hint = hintedType === 'image' || hintedType === 'video' || hintedType === 'unsupported'
      ? hintedType
      : null;

    if (!url) return hint || 'unsupported';
    if (isLikelyEmbedUrl(url)) return 'unsupported';

    const byUrl = inferMediaTypeFromUrl(url);
    if (byUrl !== 'unsupported') return byUrl;

    return hint || 'unsupported';
  }

  function isMediaReady(mediaEl, mediaType) {
    if (!mediaEl) return false;

    if (mediaType === 'image') {
      return !!(mediaEl.complete && mediaEl.naturalWidth > 0);
    }

    if (mediaType === 'video') {
      return !!getMediaUrlFromElement(mediaEl);
    }

    return false;
  }

  function createMediaItem(url, hintedType = null) {
    const normalized = normalizeUrl(url);
    if (!normalized) return null;

    return {
      url: normalized,
      mediaType: resolveMediaType(normalized, hintedType)
    };
  }

  function toMediaItems(rawItems) {
    if (!Array.isArray(rawItems)) return [];
    const items = [];

    for (const rawItem of rawItems) {
      if (!rawItem) continue;

      if (typeof rawItem === 'string') {
        const item = createMediaItem(rawItem);
        if (item) items.push(item);
        continue;
      }

      if (typeof rawItem === 'object') {
        const rawUrl = rawItem.url || rawItem.href || rawItem.src || null;
        const hintedType = rawItem.mediaType || rawItem.type || null;
        const item = createMediaItem(rawUrl, hintedType);
        if (item) items.push(item);
      }
    }

    return items;
  }

  function uniqueMediaItems(items) {
    const seen = new Set();
    const unique = [];

    for (const rawItem of toMediaItems(items)) {
      const normalized = normalizeUrl(rawItem.url);
      if (!normalized || seen.has(normalized)) continue;

      seen.add(normalized);
      unique.push({
        url: normalized,
        mediaType: rawItem.mediaType || 'unsupported'
      });
    }

    return unique;
  }

  function addGroupItem(groups, groupName, item) {
    if (!item || !item.url) return;

    if (!groups.has(groupName)) {
      groups.set(groupName, []);
    }

    groups.get(groupName).push(item);
  }

  function resolveGroupItemsFromCandidates(groups, currentUrl, modalCount, activeIndex) {
    const currentNormalized = normalizeUrl(currentUrl);
    if (!currentNormalized || !(groups instanceof Map)) return null;

    const matches = [];

    for (const [groupName, rawItems] of groups.entries()) {
      const items = uniqueMediaItems(rawItems);
      const containsCurrent = items.some((item) => normalizeUrl(item.url) === currentNormalized);
      if (!containsCurrent) continue;

      matches.push({ groupName, items });
    }

    if (!matches.length) return null;

    if (modalCount > 0) {
      const countMatches = matches.filter((match) => match.items.length === modalCount);
      if (countMatches.length === 1) return countMatches[0].items;
    }

    if (activeIndex >= 0) {
      const indexMatches = matches.filter((match) => {
        const candidate = match.items[activeIndex];
        return candidate && normalizeUrl(candidate.url) === currentNormalized;
      });

      if (indexMatches.length === 1) return indexMatches[0].items;
    }

    if (matches.length === 1) {
      return matches[0].items;
    }

    return null;
  }

  function getAnchorLikeUrl(el) {
    if (!el) return null;

    const candidates = [
      el.getAttribute('data-src'),
      el.getAttribute('data-href'),
      el.getAttribute('href'),
      el.getAttribute('src')
    ];

    for (const candidate of candidates) {
      if (!candidate) continue;

      const trimmed = String(candidate).trim();
      if (!trimmed || trimmed === '#' || trimmed.startsWith('javascript:')) continue;
      return trimmed;
    }

    return null;
  }

  function createItemFromElementUrl(el) {
    const url = getAnchorLikeUrl(el);
    if (!url) return null;

    return createMediaItem(url, getHintedMediaTypeFromElement(el));
  }

  function findFirstSupportedMedia(root) {
    if (!root) return null;

    const candidates = Array.from(root.querySelectorAll('img,video'));
    for (const el of candidates) {
      const url = getMediaUrlFromElement(el);
      const mediaType = resolveMediaType(url, getHintedMediaTypeFromElement(el));
      if ((mediaType === 'image' || mediaType === 'video') && isElementVisible(el)) {
        return el;
      }
    }

    for (const el of candidates) {
      const url = getMediaUrlFromElement(el);
      const mediaType = resolveMediaType(url, getHintedMediaTypeFromElement(el));
      if (mediaType === 'image' || mediaType === 'video') {
        return el;
      }
    }

    return null;
  }

  function getMediaSnapshotFromAdapter(adapter) {
    const mediaEl = adapter.getCurrentMediaEl ? adapter.getCurrentMediaEl() : null;
    const url = adapter.getCurrentUrl ? adapter.getCurrentUrl() : getMediaUrlFromElement(mediaEl);
    const mediaType = resolveMediaType(url, getHintedMediaTypeFromElement(mediaEl));

    return {
      mediaEl,
      url: normalizeUrl(url),
      mediaType
    };
  }

  async function waitForGalleryMediaChange(adapter, previousUrl, timeoutMs = 8000) {
    const start = Date.now();
    const previousNormalized = normalizeUrl(previousUrl);

    while (Date.now() - start < timeoutMs) {
      const snapshot = getMediaSnapshotFromAdapter(adapter);

      if (snapshot.url && snapshot.url !== previousNormalized) {
        if (snapshot.mediaType === 'video') {
          return snapshot;
        }

        if (snapshot.mediaType === 'image' && isMediaReady(snapshot.mediaEl, snapshot.mediaType)) {
          return snapshot;
        }
      }

      await sleep(250);
    }

    return null;
  }

  async function waitForSupportedGalleryOpen(timeoutMs = 5000) {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const adapter = getOpenGalleryAdapter();
      if (adapter) return adapter;
      await sleep(200);
    }

    return null;
  }

  function getFilename(url, index, mediaType) {
    try {
      const clean = url.split('?')[0];
      const last = sanitizeFilename(clean.split('/').pop());
      if (last && /\.[a-z0-9]{2,6}$/i.test(last)) {
        return last;
      }
    } catch (error) {}

    const prefix = mediaType === 'video' ? 'video' : 'image';
    const fallbackExt = mediaType === 'video' ? 'mp4' : 'jpg';
    return `${prefix}-${String(index + 1).padStart(3, '0')}.${fallbackExt}`;
  }

  function createSkippedResult(item, index, skipReason) {
    const mediaType = item && item.mediaType ? item.mediaType : 'unsupported';
    const url = item && item.url ? item.url : null;

    return {
      status: 'skipped',
      ok: false,
      url,
      filename: url ? getFilename(url, index, mediaType) : null,
      mediaType,
      skipReason
    };
  }

  function downloadMediaItem(item, index) {
    const normalized = createMediaItem(item && item.url, item && item.mediaType);
    if (!normalized) {
      return Promise.resolve(createSkippedResult(item, index, 'missing_url'));
    }

    if (normalized.mediaType !== 'image' && normalized.mediaType !== 'video') {
      return Promise.resolve(createSkippedResult(normalized, index, 'unsupported_media_type'));
    }

    return new Promise((resolve) => {
      const filename = getFilename(normalized.url, index, normalized.mediaType);

      GM_download({
        url: normalized.url,
        name: filename,
        saveAs: false,
        onload: () => {
          console.log(`Downloaded: ${filename} (${normalized.mediaType})`);
          resolve({
            status: 'downloaded',
            ok: true,
            url: normalized.url,
            filename,
            mediaType: normalized.mediaType
          });
        },
        onerror: (err) => {
          console.warn(`Failed: ${filename}`, err);
          resolve({
            status: 'failed',
            ok: false,
            url: normalized.url,
            filename,
            mediaType: normalized.mediaType,
            err
          });
        }
      });
    });
  }

  async function downloadMediaItems(items) {
    const results = [];

    for (const [index, item] of uniqueMediaItems(items).entries()) {
      const result = await downloadMediaItem(item, index);
      results.push(result);
      await sleep(250);
    }

    return results;
  }

  function isNextButtonDisabled(btn) {
    if (!btn) return true;

    return (
      btn.disabled ||
      btn.classList.contains('disabled') ||
      btn.classList.contains('inactive') ||
      btn.classList.contains('is-disabled') ||
      btn.classList.contains('lg-disabled') ||
      btn.classList.contains('w-lightbox-inactive') ||
      btn.getAttribute('aria-disabled') === 'true' ||
      btn.getAttribute('aria-hidden') === 'true' ||
      !isElementVisible(btn)
    );
  }

  function getCounterInfoFromSelectors(selectors, root) {
    const context = root || document;

    for (const selector of selectors) {
      const el = context.querySelector(selector);
      if (!el) continue;

      const info = parseCounterText(el.textContent || '');
      if (info) return info;
    }

    return null;
  }

  function getWebflowLightboxGroups() {
    const groups = new Map();

    document.querySelectorAll('.w-lightbox .w-json').forEach((script, index) => {
      try {
        const data = JSON.parse(script.textContent || '{}');
        const items = Array.isArray(data.items) ? data.items : [];
        const groupName = typeof data.group === 'string' && data.group.trim()
          ? data.group.trim()
          : `__webflow_ungrouped_${index}`;

        for (const item of items) {
          if (!item || typeof item.url !== 'string') continue;
          const mediaItem = createMediaItem(item.url, item.type || null);
          if (mediaItem) addGroupItem(groups, groupName, mediaItem);
        }
      } catch (error) {
        console.warn('Could not parse Webflow lightbox JSON', error, script);
      }
    });

    return groups;
  }

  function getWebflowModalItemCount() {
    return document.querySelectorAll('.w-lightbox-backdrop .w-lightbox-item').length;
  }

  function getWebflowActiveIndex() {
    const items = Array.from(document.querySelectorAll('.w-lightbox-backdrop .w-lightbox-item'));
    return items.findIndex((item) => item.classList.contains('w-lightbox-active'));
  }

  function resolveWebflowGroupItemsFromOpenModal(currentUrl) {
    return resolveGroupItemsFromCandidates(
      getWebflowLightboxGroups(),
      currentUrl,
      getWebflowModalItemCount(),
      getWebflowActiveIndex()
    );
  }

  function getParvusGroups() {
    const groups = new Map();
    const anchors = document.querySelectorAll(
      'a.parvus-trigger[href], a.parvus-zoom[href], a[data-group^="parvus-gallery-"][href], a[data-group][href]'
    );

    anchors.forEach((anchor, index) => {
      const groupRaw = anchor.getAttribute('data-group');
      const groupName = groupRaw && groupRaw.trim()
        ? groupRaw.trim()
        : `__parvus_ungrouped_${index}`;

      const item = createItemFromElementUrl(anchor);
      if (item) addGroupItem(groups, groupName, item);
    });

    return groups;
  }

  function getParvusCounterInfo() {
    const counter = document.querySelector('.parvus[aria-hidden="false"] .parvus__counter');
    const fromCounter = counter ? parseCounterText(counter.textContent || '') : null;
    if (fromCounter) return fromCounter;

    const visibleSlide = document.querySelector('.parvus[aria-hidden="false"] .parvus__slide[aria-hidden="false"]');
    if (!visibleSlide) return null;

    return parseCounterText(visibleSlide.getAttribute('aria-label') || '');
  }

  function resolveParvusGroupItemsFromOpenModal(currentUrl) {
    const info = getParvusCounterInfo();

    return resolveGroupItemsFromCandidates(
      getParvusGroups(),
      currentUrl,
      info ? info.total : 0,
      info ? info.index : -1
    );
  }

  function getFancyboxOpenContainer() {
    const containers = Array.from(document.querySelectorAll('.fancybox__container'));
    return containers.find((container) => {
      if (!isElementVisible(container)) return false;
      return container.classList.contains('is-open') || container.getAttribute('aria-hidden') === 'false';
    }) || null;
  }

  function getFancyboxCounterInfo(container) {
    if (!container) return null;
    return getCounterInfoFromSelectors(['.fancybox__counter', '[data-fancybox-index]'], container);
  }

  function getFancyboxGroups() {
    const groups = new Map();

    document.querySelectorAll('[data-fancybox]').forEach((trigger, index) => {
      const groupRaw = trigger.getAttribute('data-fancybox');
      const groupName = typeof groupRaw === 'string' && groupRaw.trim()
        ? groupRaw.trim()
        : `__fancybox_default_${index}`;

      const item = createItemFromElementUrl(trigger);
      if (item) addGroupItem(groups, groupName, item);
    });

    return groups;
  }

  function resolveFancyboxGroupItemsFromOpenModal(currentUrl, container) {
    const info = getFancyboxCounterInfo(container);

    return resolveGroupItemsFromCandidates(
      getFancyboxGroups(),
      currentUrl,
      info ? info.total : 0,
      info ? info.index : -1
    );
  }

  function getPhotoSwipeOpenRoot() {
    const roots = Array.from(document.querySelectorAll('.pswp'));
    return roots.find((root) => {
      if (!isElementVisible(root)) return false;
      return root.classList.contains('pswp--open') || root.getAttribute('aria-hidden') === 'false';
    }) || null;
  }

  function getPhotoSwipeCounterInfo(root) {
    if (!root) return null;
    return getCounterInfoFromSelectors(['.pswp__counter'], root);
  }

  function getPhotoSwipeGroups() {
    const groups = new Map();
    const rootIndex = new Map();
    let rootCounter = 0;

    const selector = [
      'a[href][data-pswp-width]',
      'a[href][data-pswp-height]',
      'a[href][data-pswp-src]',
      '.pswp-gallery a[href]',
      '[data-pswp-gallery] a[href]'
    ].join(', ');

    document.querySelectorAll(selector).forEach((anchor, index) => {
      const explicit = anchor.getAttribute('data-pswp') || anchor.getAttribute('data-gallery');
      let groupName = null;

      if (explicit && explicit.trim()) {
        groupName = `pswp:${explicit.trim()}`;
      } else {
        const root = anchor.closest('.pswp-gallery, [data-pswp-uid], [data-pswp-gallery], [data-gallery]');
        if (root) {
          if (!rootIndex.has(root)) {
            rootCounter += 1;
            rootIndex.set(root, rootCounter);
          }
          groupName = `pswp_root_${rootIndex.get(root)}`;
        } else {
          groupName = `__pswp_ungrouped_${index}`;
        }
      }

      const rawUrl = anchor.getAttribute('data-pswp-src') || getAnchorLikeUrl(anchor);
      const item = createMediaItem(rawUrl, getHintedMediaTypeFromElement(anchor));
      if (item) addGroupItem(groups, groupName, item);
    });

    return groups;
  }

  function resolvePhotoSwipeGroupItemsFromOpenModal(currentUrl, root) {
    const info = getPhotoSwipeCounterInfo(root);

    return resolveGroupItemsFromCandidates(
      getPhotoSwipeGroups(),
      currentUrl,
      info ? info.total : 0,
      info ? info.index : -1
    );
  }

  function getFsLightboxOpenRoot() {
    const roots = Array.from(document.querySelectorAll('.fslightbox-container, [class*="fslightbox-container"]'));
    return roots.find((root) => isElementVisible(root)) || null;
  }

  function getFsLightboxCounterInfo(root) {
    if (!root) return null;

    const selectors = [
      '[class*="slide-number"]',
      '[class*="counter"]',
      '[class*="toolbar"]',
      '[class*="number"]'
    ];

    for (const selector of selectors) {
      const elements = Array.from(root.querySelectorAll(selector));
      for (const el of elements) {
        const info = parseCounterText(el.textContent || '');
        if (info) return info;
      }
    }

    return null;
  }

  function getFsLightboxGroups() {
    const groups = new Map();

    document.querySelectorAll('[data-fslightbox]').forEach((trigger, index) => {
      const groupRaw = trigger.getAttribute('data-fslightbox');
      const groupName = typeof groupRaw === 'string' && groupRaw.trim()
        ? groupRaw.trim()
        : `__fslightbox_default_${index}`;

      const item = createItemFromElementUrl(trigger);
      if (item) addGroupItem(groups, groupName, item);
    });

    return groups;
  }

  function resolveFsLightboxGroupItemsFromOpenModal(currentUrl, root) {
    const info = getFsLightboxCounterInfo(root);

    return resolveGroupItemsFromCandidates(
      getFsLightboxGroups(),
      currentUrl,
      info ? info.total : 0,
      info ? info.index : -1
    );
  }

  function getGLightboxOpenContainer() {
    const containers = Array.from(document.querySelectorAll('.glightbox-container'));

    return containers.find((container) => {
      if (!isElementVisible(container)) return false;
      return (
        container.classList.contains('open') ||
        document.body.classList.contains('glightbox-open') ||
        container.getAttribute('aria-hidden') === 'false'
      );
    }) || null;
  }

  function getGLightboxCounterInfo(container) {
    if (!container) return null;

    const slides = Array.from(container.querySelectorAll('.gslide'));
    if (!slides.length) return null;

    const activeIndex = slides.findIndex((slide) => slide.classList.contains('current'));
    if (activeIndex < 0) return null;

    return {
      index: activeIndex,
      total: slides.length
    };
  }

  function getGLightboxGroups() {
    const groups = new Map();
    const selector = [
      'a.glightbox[href]',
      'a[data-gallery][href]',
      '[data-glightbox][href]',
      '[data-gallery][data-href]',
      '[data-glightbox][data-href]'
    ].join(', ');

    document.querySelectorAll(selector).forEach((trigger, index) => {
      const rawGroup = trigger.getAttribute('data-gallery');
      const groupName = rawGroup && rawGroup.trim()
        ? rawGroup.trim()
        : `__glightbox_default_${index}`;

      const hinted = getHintedMediaTypeFromText(trigger.getAttribute('data-glightbox')) ||
        getHintedMediaTypeFromElement(trigger);

      const item = createMediaItem(
        trigger.getAttribute('data-href') || trigger.getAttribute('data-src') || getAnchorLikeUrl(trigger),
        hinted
      );

      if (item) addGroupItem(groups, groupName, item);
    });

    return groups;
  }

  function resolveGLightboxGroupItemsFromOpenModal(currentUrl, container) {
    const info = getGLightboxCounterInfo(container);

    return resolveGroupItemsFromCandidates(
      getGLightboxGroups(),
      currentUrl,
      info ? info.total : 0,
      info ? info.index : -1
    );
  }

  function getLightbox2CounterInfo() {
    const numberEl = document.querySelector('#lightbox .lb-number');
    return numberEl ? parseCounterText(numberEl.textContent || '') : null;
  }

  function getLightbox2Groups() {
    const groups = new Map();

    document.querySelectorAll('a[data-lightbox][href]').forEach((anchor, index) => {
      const raw = anchor.getAttribute('data-lightbox');
      const groupName = raw && raw.trim()
        ? raw.trim()
        : `__lightbox2_default_${index}`;

      const item = createItemFromElementUrl(anchor);
      if (item) addGroupItem(groups, groupName, item);
    });

    return groups;
  }

  function resolveLightbox2GroupItemsFromOpenModal(currentUrl) {
    const info = getLightbox2CounterInfo();

    return resolveGroupItemsFromCandidates(
      getLightbox2Groups(),
      currentUrl,
      info ? info.total : 0,
      info ? info.index : -1
    );
  }

  const lightGalleryAdapter = {
    name: 'LightGallery',
    isOpen() {
      const root = document.querySelector('.lg-outer, .lg-container');
      return !!(root && isElementVisible(root) && document.querySelector('.lg-item.lg-current'));
    },
    getCurrentMediaEl() {
      const current = document.querySelector('.lg-item.lg-current');
      return current ? findFirstSupportedMedia(current) : null;
    },
    getCurrentUrl() {
      return getMediaUrlFromElement(this.getCurrentMediaEl());
    },
    getNextButton() {
      return document.querySelector('.lg-next');
    },
    isNextDisabled(btn) {
      return isNextButtonDisabled(btn);
    },
    async getAllUrls() {
      return null;
    },
    async waitForNext(previousUrl, timeoutMs = 10000) {
      return waitForGalleryMediaChange(this, previousUrl, timeoutMs);
    }
  };

  const webflowLightboxAdapter = {
    name: 'Webflow Lightbox',
    isOpen() {
      const backdrop = document.querySelector('.w-lightbox-backdrop');
      return isElementVisible(backdrop);
    },
    getCurrentMediaEl() {
      const backdrop = document.querySelector('.w-lightbox-backdrop');
      if (!backdrop) return null;

      return backdrop.querySelector('.w-lightbox-image, video') || findFirstSupportedMedia(backdrop);
    },
    getCurrentUrl() {
      return getMediaUrlFromElement(this.getCurrentMediaEl());
    },
    getNextButton() {
      return document.querySelector('.w-lightbox-backdrop .w-lightbox-right');
    },
    isNextDisabled(btn) {
      return isNextButtonDisabled(btn);
    },
    async getAllUrls() {
      const currentUrl = this.getCurrentUrl();
      const itemsFromJson = resolveWebflowGroupItemsFromOpenModal(currentUrl);
      if (itemsFromJson && itemsFromJson.length) {
        console.log('Resolved Webflow lightbox media from w-json metadata.');
        return uniqueMediaItems(itemsFromJson);
      }

      const thumbnailItems = Array.from(document.querySelectorAll('.w-lightbox-backdrop .w-lightbox-thumbnail-image'))
        .map((img) => createMediaItem(getMediaUrlFromElement(img), 'image'))
        .filter(Boolean);

      if (thumbnailItems.length) {
        console.log('Falling back to Webflow lightbox thumbnail media.');
        return uniqueMediaItems(thumbnailItems);
      }

      return null;
    },
    async waitForNext(previousUrl, timeoutMs = 10000) {
      return waitForGalleryMediaChange(this, previousUrl, timeoutMs);
    }
  };

  const parvusLightboxAdapter = {
    name: 'Parvus Lightbox',
    isOpen() {
      return isElementVisible(document.querySelector('.parvus[aria-hidden="false"]'));
    },
    getCurrentMediaEl() {
      const activeSlide = document.querySelector('.parvus[aria-hidden="false"] .parvus__slide[aria-hidden="false"]');
      if (activeSlide) {
        const direct = activeSlide.querySelector('img, video');
        if (direct) return direct;
      }

      const modal = document.querySelector('.parvus[aria-hidden="false"]');
      return modal ? findFirstSupportedMedia(modal) : null;
    },
    getCurrentUrl() {
      return getMediaUrlFromElement(this.getCurrentMediaEl());
    },
    getNextButton() {
      return document.querySelector('.parvus[aria-hidden="false"] .parvus__btn--next');
    },
    isNextDisabled(btn) {
      return isNextButtonDisabled(btn);
    },
    async getAllUrls() {
      const items = resolveParvusGroupItemsFromOpenModal(this.getCurrentUrl());
      if (items && items.length) {
        console.log('Resolved Parvus lightbox media from trigger metadata.');
        return uniqueMediaItems(items);
      }

      return null;
    },
    async waitForNext(previousUrl, timeoutMs = 10000) {
      return waitForGalleryMediaChange(this, previousUrl, timeoutMs);
    }
  };

  const fancyboxAdapter = {
    name: 'Fancybox',
    isOpen() {
      return !!getFancyboxOpenContainer();
    },
    getCurrentMediaEl() {
      const container = getFancyboxOpenContainer();
      if (!container) return null;

      const selected = container.querySelector('.fancybox__slide.is-selected, .fancybox__carousel .is-selected');
      if (selected) {
        const direct = selected.querySelector('img.fancybox-image, img, video');
        if (direct) return direct;
      }

      return findFirstSupportedMedia(container);
    },
    getCurrentUrl() {
      return getMediaUrlFromElement(this.getCurrentMediaEl());
    },
    getNextButton() {
      const container = getFancyboxOpenContainer();
      return container
        ? container.querySelector('.fancybox__button--next, [data-fancybox-next], .carousel__button.is-next')
        : null;
    },
    isNextDisabled(btn) {
      return isNextButtonDisabled(btn);
    },
    async getAllUrls() {
      const container = getFancyboxOpenContainer();
      const items = resolveFancyboxGroupItemsFromOpenModal(this.getCurrentUrl(), container);
      if (items && items.length) {
        console.log('Resolved Fancybox group media from data-fancybox triggers.');
        return uniqueMediaItems(items);
      }

      return null;
    },
    async waitForNext(previousUrl, timeoutMs = 10000) {
      return waitForGalleryMediaChange(this, previousUrl, timeoutMs);
    }
  };

  const photoSwipeAdapter = {
    name: 'PhotoSwipe',
    isOpen() {
      return !!getPhotoSwipeOpenRoot();
    },
    getCurrentMediaEl() {
      const root = getPhotoSwipeOpenRoot();
      if (!root) return null;

      const activeItem = root.querySelector('.pswp__item:not([aria-hidden="true"])');
      if (activeItem) {
        const direct = activeItem.querySelector('img.pswp__img, img, video');
        if (direct) return direct;
      }

      return findFirstSupportedMedia(root);
    },
    getCurrentUrl() {
      return getMediaUrlFromElement(this.getCurrentMediaEl());
    },
    getNextButton() {
      const root = getPhotoSwipeOpenRoot();
      return root ? root.querySelector('.pswp__button--arrow--next, .pswp__button--arrow-next') : null;
    },
    isNextDisabled(btn) {
      return isNextButtonDisabled(btn);
    },
    async getAllUrls() {
      const root = getPhotoSwipeOpenRoot();
      const items = resolvePhotoSwipeGroupItemsFromOpenModal(this.getCurrentUrl(), root);
      if (items && items.length) {
        console.log('Resolved PhotoSwipe group media from gallery triggers.');
        return uniqueMediaItems(items);
      }

      return null;
    },
    async waitForNext(previousUrl, timeoutMs = 10000) {
      return waitForGalleryMediaChange(this, previousUrl, timeoutMs);
    }
  };

  const fsLightboxAdapter = {
    name: 'FS Lightbox',
    isOpen() {
      return !!getFsLightboxOpenRoot();
    },
    getCurrentMediaEl() {
      const root = getFsLightboxOpenRoot();
      if (!root) return null;

      const activeSlide = root.querySelector('[class*="slide"][class*="active"], [class*="slide"][style*="opacity: 1"]');
      if (activeSlide) {
        const direct = activeSlide.querySelector('img, video');
        if (direct) return direct;
      }

      return findFirstSupportedMedia(root);
    },
    getCurrentUrl() {
      return getMediaUrlFromElement(this.getCurrentMediaEl());
    },
    getNextButton() {
      const root = getFsLightboxOpenRoot();
      return root
        ? root.querySelector('[class*="next"], [aria-label="Next"], [title="Next"]')
        : null;
    },
    isNextDisabled(btn) {
      return isNextButtonDisabled(btn);
    },
    async getAllUrls() {
      const root = getFsLightboxOpenRoot();
      const items = resolveFsLightboxGroupItemsFromOpenModal(this.getCurrentUrl(), root);
      if (items && items.length) {
        console.log('Resolved FS Lightbox media from data-fslightbox groups.');
        return uniqueMediaItems(items);
      }

      return null;
    },
    async waitForNext(previousUrl, timeoutMs = 10000) {
      return waitForGalleryMediaChange(this, previousUrl, timeoutMs);
    }
  };

  const glightboxAdapter = {
    name: 'GLightbox',
    isOpen() {
      return !!getGLightboxOpenContainer();
    },
    getCurrentMediaEl() {
      const container = getGLightboxOpenContainer();
      if (!container) return null;

      const active = container.querySelector('.gslide.current, .gslide.loaded.current');
      if (active) {
        const direct = active.querySelector('img, video');
        if (direct) return direct;
      }

      return findFirstSupportedMedia(container);
    },
    getCurrentUrl() {
      return getMediaUrlFromElement(this.getCurrentMediaEl());
    },
    getNextButton() {
      const container = getGLightboxOpenContainer();
      return container ? container.querySelector('.gnext') : null;
    },
    isNextDisabled(btn) {
      return isNextButtonDisabled(btn);
    },
    async getAllUrls() {
      const container = getGLightboxOpenContainer();
      const items = resolveGLightboxGroupItemsFromOpenModal(this.getCurrentUrl(), container);
      if (items && items.length) {
        console.log('Resolved GLightbox media from trigger groups.');
        return uniqueMediaItems(items);
      }

      return null;
    },
    async waitForNext(previousUrl, timeoutMs = 10000) {
      return waitForGalleryMediaChange(this, previousUrl, timeoutMs);
    }
  };

  const lightbox2Adapter = {
    name: 'Lightbox2',
    isOpen() {
      return isElementVisible(document.getElementById('lightboxOverlay')) && isElementVisible(document.getElementById('lightbox'));
    },
    getCurrentMediaEl() {
      const lightbox = document.getElementById('lightbox');
      if (!lightbox) return null;

      return lightbox.querySelector('img.lb-image, video') || findFirstSupportedMedia(lightbox);
    },
    getCurrentUrl() {
      return getMediaUrlFromElement(this.getCurrentMediaEl());
    },
    getNextButton() {
      return document.querySelector('#lightbox a.lb-next');
    },
    isNextDisabled(btn) {
      return isNextButtonDisabled(btn);
    },
    async getAllUrls() {
      const items = resolveLightbox2GroupItemsFromOpenModal(this.getCurrentUrl());
      if (items && items.length) {
        console.log('Resolved Lightbox2 media from data-lightbox groups.');
        return uniqueMediaItems(items);
      }

      return null;
    },
    async waitForNext(previousUrl, timeoutMs = 10000) {
      return waitForGalleryMediaChange(this, previousUrl, timeoutMs);
    }
  };

  const magnificPopupAdapter = {
    name: 'Magnific Popup',
    isOpen() {
      return isElementVisible(document.querySelector('.mfp-wrap.mfp-ready'));
    },
    getCurrentMediaEl() {
      const wrap = document.querySelector('.mfp-wrap.mfp-ready');
      if (!wrap) return null;

      return wrap.querySelector('.mfp-content .mfp-img, .mfp-content video') || findFirstSupportedMedia(wrap);
    },
    getCurrentUrl() {
      return getMediaUrlFromElement(this.getCurrentMediaEl());
    },
    getNextButton() {
      return document.querySelector('.mfp-wrap.mfp-ready .mfp-arrow-right');
    },
    isNextDisabled(btn) {
      return isNextButtonDisabled(btn);
    },
    async getAllUrls() {
      return null;
    },
    async waitForNext(previousUrl, timeoutMs = 10000) {
      return waitForGalleryMediaChange(this, previousUrl, timeoutMs);
    }
  };

  const galleryAdapters = [
    lightGalleryAdapter,
    webflowLightboxAdapter,
    parvusLightboxAdapter,
    fancyboxAdapter,
    photoSwipeAdapter,
    fsLightboxAdapter,
    glightboxAdapter,
    lightbox2Adapter,
    magnificPopupAdapter
  ];

  function getOpenGalleryAdapter() {
    return galleryAdapters.find((adapter) => adapter.isOpen()) || null;
  }

  async function downloadByStepping(adapter) {
    const seen = new Set();
    const results = [];
    let index = 0;

    while (true) {
      const snapshot = getMediaSnapshotFromAdapter(adapter);
      const currentUrl = snapshot ? snapshot.url : null;
      const currentType = snapshot ? snapshot.mediaType : 'unsupported';

      if (!currentUrl) {
        console.warn('No current media URL found. Stopping.');
        break;
      }

      if (seen.has(currentUrl)) {
        console.log('Already seen this media URL. Assuming end of gallery.');
        break;
      }

      seen.add(currentUrl);

      const result = await downloadMediaItem({
        url: currentUrl,
        mediaType: currentType
      }, index);
      results.push(result);
      index++;

      await sleep(500);

      const nextBtn = adapter.getNextButton();
      if (!nextBtn || adapter.isNextDisabled(nextBtn)) {
        console.log('Next button unavailable or disabled. Stopping.');
        break;
      }

      nextBtn.click();

      const nextSnapshot = await adapter.waitForNext(currentUrl, 10000);
      if (!nextSnapshot) {
        console.log('No new media appeared after clicking next. Stopping.');
        break;
      }

      await sleep(500);
    }

    return results;
  }

  function summarizeResults(results) {
    return {
      downloaded: results.filter((result) => result.status === 'downloaded').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
      failed: results.filter((result) => result.status === 'failed').length
    };
  }

  async function runDownloader() {
    const adapter = await waitForSupportedGalleryOpen();

    if (!adapter) {
      alert(
        'No supported open gallery detected. Open a supported lightbox first ' +
        '(LightGallery, Webflow, Parvus, Fancybox, PhotoSwipe, FS Lightbox, GLightbox, Lightbox2, or Magnific Popup).'
      );
      return;
    }

    let results = [];

    const directItems = await adapter.getAllUrls();
    if (directItems && directItems.length) {
      results = await downloadMediaItems(directItems);
    } else {
      results = await downloadByStepping(adapter);
    }

    const counts = summarizeResults(results);
    alert(`Done. ${counts.downloaded} downloaded, ${counts.skipped} skipped, ${counts.failed} failed from ${adapter.name}.`);
    console.log('Download results:', results);
  }

  function ensureStyles() {
    if (stylesInjected) return;
    stylesInjected = true;

    GM_addStyle(`
      #${BTN_ID} {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        padding: 10px 14px;
        border: none;
        border-radius: 8px;
        background: #111;
        color: #fff;
        font: 14px/1.2 sans-serif;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      }

      #${BTN_ID}:hover {
        opacity: 0.92;
      }
    `);
  }

  function addButton() {
    if (document.getElementById(BTN_ID)) return;

    ensureStyles();

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.textContent = 'Download Open Gallery';
    btn.addEventListener('click', runDownloader);
    document.body.appendChild(btn);
  }

  function removeButton() {
    const btn = document.getElementById(BTN_ID);
    if (btn) btn.remove();
  }

  function syncButtonVisibility() {
    if (getOpenGalleryAdapter()) {
      addButton();
    } else {
      removeButton();
    }
  }

  const observer = new MutationObserver(() => {
    syncButtonVisibility();
  });

  function init() {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'src', 'style', 'aria-hidden', 'aria-disabled']
    });

    syncButtonVisibility();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
