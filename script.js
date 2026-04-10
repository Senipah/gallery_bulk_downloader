// ==UserScript==
// @name         Gallery Bulk Downloader
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Download image/video files from supported open lightbox overlays
// @match        *://*/*
// @grant        GM_download
// @grant        GM_addStyle
// @grant        GM_info
// ==/UserScript==

(function () {
  'use strict';

  const BTN_ID = 'tm-gallery-download-btn';
  const STATUS_ID = 'tm-gallery-download-status';
  const PROMPT_FOR_FOLDER_NAME = true;
  let stylesInjected = false;
  let runInProgress = false;
  let statusHideTimer = null;

  const WINDOWS_RESERVED_NAMES = new Set([
    'con', 'prn', 'aux', 'nul',
    'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
    'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
  ]);

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

  function getDownloadMode() {
    try {
      if (typeof GM_info === 'object' && GM_info && typeof GM_info.downloadMode === 'string') {
        return GM_info.downloadMode;
      }
    } catch (error) {}
    return 'unknown';
  }

  function supportsSubfolderDownloadPaths() {
    return getDownloadMode() === 'browser';
  }

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

  function sanitizePathSegment(name, fallback = '') {
    let cleaned = sanitizeFilename(name)
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim();

    if (cleaned.length > 100) {
      cleaned = cleaned.slice(0, 100).replace(/[. ]+$/g, '').trim();
    }

    if (!cleaned) return fallback;

    if (WINDOWS_RESERVED_NAMES.has(cleaned.toLowerCase())) {
      cleaned = `_${cleaned}`;
    }

    return cleaned || fallback;
  }

  function getDownloadSubdirectoryName() {
    const fromTitle = sanitizePathSegment(document.title, '');
    if (fromTitle) return fromTitle;

    const fromHost = sanitizePathSegment(window.location.hostname, '');
    if (fromHost) return fromHost;

    return 'gallery-downloads';
  }

  function chooseDownloadSubdirectory(defaultName) {
    if (!PROMPT_FOR_FOLDER_NAME) return defaultName;

    const input = window.prompt(
      'Folder name under Downloads (leave blank to use page title):',
      defaultName
    );

    if (input === null) return null;

    const trimmed = String(input).trim();
    if (!trimmed) return defaultName;

    return sanitizePathSegment(trimmed, defaultName);
  }

  function buildDownloadName(filename, downloadSubdirectory) {
    if (!filename) return null;
    if (!downloadSubdirectory) return filename;
    return `${downloadSubdirectory}/${filename}`;
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

  function createSkippedResult(item, index, skipReason, downloadSubdirectory = '') {
    const mediaType = item && item.mediaType ? item.mediaType : 'unsupported';
    const url = item && item.url ? item.url : null;
    const filename = url ? getFilename(url, index, mediaType) : null;
    const downloadName = buildDownloadName(filename, downloadSubdirectory);

    return {
      status: 'skipped',
      ok: false,
      url,
      filename,
      downloadName,
      mediaType,
      skipReason
    };
  }

  function downloadMediaItem(item, index, downloadSubdirectory = '') {
    const normalized = createMediaItem(item && item.url, item && item.mediaType);
    if (!normalized) {
      return Promise.resolve(createSkippedResult(item, index, 'missing_url', downloadSubdirectory));
    }

    if (normalized.mediaType !== 'image' && normalized.mediaType !== 'video') {
      return Promise.resolve(createSkippedResult(normalized, index, 'unsupported_media_type', downloadSubdirectory));
    }

    return new Promise((resolve) => {
      const filename = getFilename(normalized.url, index, normalized.mediaType);
      const downloadName = buildDownloadName(filename, downloadSubdirectory);

      GM_download({
        url: normalized.url,
        name: downloadName,
        saveAs: false,
        onload: () => {
          console.log(`Downloaded: ${downloadName} (${normalized.mediaType})`);
          resolve({
            status: 'downloaded',
            ok: true,
            url: normalized.url,
            filename,
            downloadName,
            mediaType: normalized.mediaType
          });
        },
        onerror: (err) => {
          console.warn(`Failed: ${downloadName}`, err);
          resolve({
            status: 'failed',
            ok: false,
            url: normalized.url,
            filename,
            downloadName,
            mediaType: normalized.mediaType,
            err
          });
        }
      });
    });
  }

  async function downloadMediaItems(items, downloadSubdirectory = '', onProgress = null) {
    const results = [];
    const deduped = uniqueMediaItems(items);
    const total = deduped.length;

    for (const [index, item] of deduped.entries()) {
      const result = await downloadMediaItem(item, index, downloadSubdirectory);
      results.push(result);
      if (typeof onProgress === 'function') {
        onProgress({
          result,
          processed: index + 1,
          total
        });
      }
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
      btn.classList.contains('swiper-button-disabled') ||
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

  function getFraserLightboxRoot() {
    const roots = Array.from(document.querySelectorAll('.lightbox-gallery'));
    return roots.find((root) => {
      if (!isElementVisible(root)) return false;
      if (!root.querySelector('.swiper-wrapper, .swiper-slide')) return false;

      return !!root.querySelector(
        '[data-testid="closeLightboxIcon"], [data-testid="zoomInPictureButton"], .swiper-button-next, .swiper-button-prev'
      );
    }) || null;
  }

  function getFraserWidthHint(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return 0;

    try {
      const parsed = new URL(normalized);
      const width = Number(parsed.searchParams.get('w'));
      return Number.isFinite(width) && width > 0 ? width : 0;
    } catch (error) {
      return 0;
    }
  }

  function isFraserMediaUrl(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return false;

    try {
      const parsed = new URL(normalized);
      return parsed.hostname.toLowerCase() === 'media.fraseryachts.com';
    } catch (error) {
      return false;
    }
  }

  function getBestFraserSlideUrl(slide) {
    if (!slide) return null;

    const candidates = [];
    slide.querySelectorAll('picture source[srcset]').forEach((source) => {
      const urls = extractUrlsFromSrcset(source.getAttribute('srcset'));
      candidates.push(...urls);
    });

    slide.querySelectorAll('img').forEach((img) => {
      const direct = getMediaUrlFromElement(img);
      if (direct) candidates.push(direct);

      const srcsetUrls = extractUrlsFromSrcset(img.getAttribute('srcset'));
      candidates.push(...srcsetUrls);
    });

    slide.querySelectorAll('video,source[src]').forEach((el) => {
      const direct = getMediaUrlFromElement(el);
      if (direct) candidates.push(direct);
    });

    const unique = uniqueMediaItems(candidates);
    if (!unique.length) return null;

    const ranked = unique
      .filter((item) => item.mediaType === 'image' || item.mediaType === 'video')
      .sort((a, b) => {
        const fraserDelta = Number(isFraserMediaUrl(b.url)) - Number(isFraserMediaUrl(a.url));
        if (fraserDelta !== 0) return fraserDelta;

        const widthDelta = getFraserWidthHint(b.url) - getFraserWidthHint(a.url);
        if (widthDelta !== 0) return widthDelta;

        return String(b.url).length - String(a.url).length;
      });

    return ranked.length ? ranked[0].url : null;
  }

  function getFraserCounterInfo(root) {
    if (!root) return null;

    const activeSlide = root.querySelector('.swiper-slide.swiper-slide-active[aria-label]');
    if (!activeSlide) return null;

    return parseCounterText(activeSlide.getAttribute('aria-label') || '');
  }

  function getWixProGalleryFullscreenView() {
    const view = document.querySelector('[data-hook="fullscreen-view"]');
    if (!view || !isElementVisible(view)) return null;
    if (view.getAttribute('aria-hidden') === 'true') return null;
    return view;
  }

  function normalizeWixMediaUrl(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return null;

    try {
      const parsed = new URL(normalized);
      if (parsed.hostname !== 'static.wixstatic.com') return normalized;

      const match = parsed.pathname.match(/^\/media\/([^/]+\.[a-z0-9]+)(?:\/v1\/.*)?$/i);
      if (!match) return normalized;
      return `${parsed.origin}/media/${match[1]}`;
    } catch (error) {
      return normalized;
    }
  }

  function extractUrlsFromSrcset(srcset) {
    if (!srcset) return [];

    const normalized = String(srcset).trim();
    if (!normalized) return [];

    // Split candidates on commas that are followed by a likely URL start.
    // This avoids breaking Wix URLs that contain commas inside the URL path.
    let candidates = normalized.split(/,(?=\s*(?:https?:|\/\/|\/|\.\/|\.\.\/|data:|blob:))/i);
    if (candidates.length === 1) {
      candidates = normalized.split(/,\s+/);
    }

    return candidates
      .map((candidate) => {
        const trimmed = candidate.trim();
        if (!trimmed) return '';

        const firstWhitespace = trimmed.search(/\s/);
        return (firstWhitespace < 0 ? trimmed : trimmed.slice(0, firstWhitespace)).trim();
      })
      .filter(Boolean);
  }

  function getWixProGalleryItemsFromOpenModal(root) {
    if (!root) return [];

    const items = [];

    root.querySelectorAll('.thumbnailItem[data-key]').forEach((thumb) => {
      const backgroundImage = thumb.style && thumb.style.backgroundImage
        ? thumb.style.backgroundImage
        : '';
      const match = backgroundImage.match(/url\(["']?([^"')]+)["']?\)/i);
      if (!match || !match[1]) return;

      const item = createMediaItem(normalizeWixMediaUrl(match[1]), 'image');
      if (item) items.push(item);
    });

    root.querySelectorAll('[data-hook="gallery-item-image-img"]').forEach((img) => {
      const item = createMediaItem(normalizeWixMediaUrl(getMediaUrlFromElement(img)), 'image');
      if (item) items.push(item);
    });

    root.querySelectorAll('picture source[srcset]').forEach((source) => {
      const urls = extractUrlsFromSrcset(source.getAttribute('srcset'));
      for (const url of urls) {
        const item = createMediaItem(normalizeWixMediaUrl(url), 'image');
        if (item) items.push(item);
      }
    });

    return uniqueMediaItems(items);
  }

  function getBookingSingleViewRoot() {
    const root = document.querySelector('[data-testid="PropertyGallerySingleView-wrapper"] [data-testid="gallery-single-view"]') ||
      document.querySelector('[data-testid="gallery-single-view"]');
    return root && isElementVisible(root) ? root : null;
  }

  function getBookingGalleryCounterInfo(root) {
    if (!root) return null;

    return getCounterInfoFromSelectors(
      ['[data-testid="gallery-single-view-counter-text"]'],
      root
    );
  }

  function getBookingThumbnailButtonCount(root) {
    const context = root || document;
    return context.querySelectorAll('[data-testid^="gallery-photo-thumb-"]').length;
  }

  function getBookingPhotoIdFromElement(el) {
    const holder = el && el.closest
      ? el.closest('[data-testid^="gallery-photo-"], [data-testid^="gallery-photo-thumb-"], [data-testid^="gallery-grid-photo-action-"]')
      : null;
    if (!holder) return null;

    const testId = holder.getAttribute('data-testid') || '';
    const match = testId.match(/(\d+)(?!.*\d)/);
    return match ? match[1] : null;
  }

  function getBookingGalleryDomItems() {
    const orderedSelectors = [
      '[data-testid="gallery-single-view-image-switcher"] img',
      '[data-testid="gallery-single-view-thumbnails"] img'
    ];

    const byPhotoId = new Map();
    for (const selector of orderedSelectors) {
      document.querySelectorAll(selector).forEach((img) => {
        const item = createMediaItem(getMediaUrlFromElement(img), 'image');
        if (!item) return;

        const photoId = getBookingPhotoIdFromElement(img) || item.url;
        if (!byPhotoId.has(photoId)) {
          byPhotoId.set(photoId, item);
        }
      });
    }

    return uniqueMediaItems(Array.from(byPhotoId.values()));
  }

  function isSuperYachtTimesHost() {
    const host = String(window.location.hostname || '').toLowerCase();
    return host === 'superyachttimes.com' || host.endsWith('.superyachttimes.com');
  }

  let superYachtTimesCache = {
    href: '',
    nextData: null,
    mediaItems: null
  };

  function ensureSuperYachtTimesCache() {
    const href = window.location.href;
    if (superYachtTimesCache.href !== href) {
      superYachtTimesCache = {
        href,
        nextData: null,
        mediaItems: null
      };
    }
  }

  function getSuperYachtTimesNextData() {
    if (!isSuperYachtTimesHost()) return null;

    ensureSuperYachtTimesCache();
    if (superYachtTimesCache.nextData) return superYachtTimesCache.nextData;

    const script = document.getElementById('__NEXT_DATA__');
    if (!script) return null;

    try {
      const parsed = JSON.parse(script.textContent || '{}');
      superYachtTimesCache.nextData = parsed;
      return parsed;
    } catch (error) {
      console.warn('Could not parse __NEXT_DATA__ for SuperYacht Times gallery extraction.', error);
      return null;
    }
  }

  function normalizeSuperYachtTimesPhotoUrl(rawUrl, photoId = '') {
    if (!rawUrl) return null;

    const trimmed = String(rawUrl).trim();
    if (!trimmed) return null;

    if (/^https?:\/\//i.test(trimmed)) return trimmed;

    const cleaned = trimmed.replace(/^\/+/, '');
    if (/^download\//i.test(cleaned)) {
      return `https://photos.superyachtapi.com/${cleaned}`;
    }

    if (/^photo\//i.test(cleaned)) {
      return `https://photos.superyachtapi.com/download/${cleaned}`;
    }

    if (/^(extra[-_]large|large|medium|small)$/i.test(cleaned) && photoId) {
      const normalizedSize = cleaned.replace('_', '-').toLowerCase();
      return `https://photos.superyachtapi.com/download/${photoId}/${normalizedSize}`;
    }

    return `https://photos.superyachtapi.com/download/${cleaned}`;
  }

  function getSuperYachtTimesPreferredPhotoPath(photo) {
    if (!photo || typeof photo !== 'object') return null;

    const versions = Array.isArray(photo.versions) ? photo.versions : [];
    const preferredVersionOrder = ['extra_large', 'large', 'original', 'medium', 'small'];
    for (const preferred of preferredVersionOrder) {
      const version = versions.find((candidate) => {
        if (!candidate || typeof candidate !== 'object') return false;
        const versionName = String(candidate.name || '').toLowerCase().replace(/-/g, '_');
        return versionName === preferred;
      });
      if (version && typeof version.id === 'string' && version.id.trim()) {
        return version.id.trim();
      }
    }

    const urls = photo.urls && typeof photo.urls === 'object' ? photo.urls : null;
    if (!urls) return null;

    const preferredUrlOrder = ['extraLarge', 'extra_large', 'large', 'medium', 'small'];
    for (const key of preferredUrlOrder) {
      const candidate = urls[key];
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }

    return null;
  }

  function getSuperYachtTimesGalleryItems() {
    if (!isSuperYachtTimesHost()) return [];

    ensureSuperYachtTimesCache();
    if (Array.isArray(superYachtTimesCache.mediaItems)) {
      return superYachtTimesCache.mediaItems;
    }

    const nextData = getSuperYachtTimesNextData();
    const pageProps = nextData && nextData.props ? nextData.props.pageProps : null;
    const articleInfo = pageProps && pageProps.articleInfo ? pageProps.articleInfo : null;
    const imagesById = articleInfo && typeof articleInfo.images === 'object'
      ? articleInfo.images
      : null;

    if (!imagesById) {
      superYachtTimesCache.mediaItems = [];
      return superYachtTimesCache.mediaItems;
    }

    const explicitIds = Array.isArray(pageProps && pageProps.imageIds)
      ? pageProps.imageIds.map((id) => String(id))
      : [];
    const imageIds = explicitIds.length ? explicitIds : Object.keys(imagesById);

    const items = [];
    for (const imageId of imageIds) {
      const photo = imagesById[imageId];
      if (!photo) continue;

      const preferredPath = getSuperYachtTimesPreferredPhotoPath(photo);
      const absoluteUrl = normalizeSuperYachtTimesPhotoUrl(preferredPath, imageId);
      const item = createMediaItem(absoluteUrl, 'image');
      if (item) items.push(item);
    }

    superYachtTimesCache.mediaItems = uniqueMediaItems(items);
    return superYachtTimesCache.mediaItems;
  }

  function getSuperYachtTimesCurrentMediaElement() {
    const candidates = Array.from(document.querySelectorAll('img[src*="photos.superyachtapi.com/download"]'));
    for (const img of candidates) {
      if (isElementVisible(img)) return img;
    }

    return candidates[0] || findFirstSupportedMedia(document.body);
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

  const fraserGalleryAdapter = {
    name: 'Fraser Gallery',
    isOpen() {
      return !!getFraserLightboxRoot();
    },
    getCurrentMediaEl() {
      const root = getFraserLightboxRoot();
      if (!root) return null;

      const activeSlide = root.querySelector('.swiper-slide.swiper-slide-active');
      if (activeSlide) {
        const direct = activeSlide.querySelector('img, video');
        if (direct) return direct;
      }

      return findFirstSupportedMedia(root);
    },
    getCurrentUrl() {
      const root = getFraserLightboxRoot();
      if (!root) return null;

      const activeSlide = root.querySelector('.swiper-slide.swiper-slide-active');
      const bestUrl = getBestFraserSlideUrl(activeSlide);
      if (bestUrl) return bestUrl;

      return getMediaUrlFromElement(this.getCurrentMediaEl());
    },
    getNextButton() {
      const root = getFraserLightboxRoot();
      return root ? root.querySelector('.swiper-button-next[aria-label*="Next"], .swiper-button-next') : null;
    },
    isNextDisabled(btn) {
      return isNextButtonDisabled(btn);
    },
    async getAllUrls() {
      const root = getFraserLightboxRoot();
      if (!root) return null;

      const items = [];
      root.querySelectorAll('.swiper-slide[role="group"]').forEach((slide) => {
        const bestUrl = getBestFraserSlideUrl(slide);
        const item = createMediaItem(bestUrl, 'image');
        if (item) items.push(item);
      });

      const uniqueItems = uniqueMediaItems(items);
      if (!uniqueItems.length) return null;

      const counterInfo = getFraserCounterInfo(root);
      const nextBtn = this.getNextButton();
      if (counterInfo && counterInfo.total > 1 && nextBtn && uniqueItems.length < counterInfo.total) {
        console.log(`Fraser gallery direct list incomplete (${uniqueItems.length}/${counterInfo.total}); using step-through fallback.`);
        return null;
      }

      return uniqueItems;
    },
    async waitForNext(previousUrl, timeoutMs = 10000) {
      return waitForGalleryMediaChange(this, previousUrl, timeoutMs);
    }
  };

  const wixProGalleryAdapter = {
    name: 'Wix Pro Gallery',
    isOpen() {
      return !!getWixProGalleryFullscreenView();
    },
    getCurrentMediaEl() {
      const root = getWixProGalleryFullscreenView();
      if (!root) return null;

      const activeContainer = root.querySelector('[data-hook="item-container"][aria-hidden="false"]');
      if (activeContainer) {
        const activeImage = activeContainer.querySelector('[data-hook="gallery-item-image-img"], img, video');
        if (activeImage) return activeImage;
      }

      return findFirstSupportedMedia(root);
    },
    getCurrentUrl() {
      return normalizeWixMediaUrl(getMediaUrlFromElement(this.getCurrentMediaEl()));
    },
    getNextButton() {
      const root = getWixProGalleryFullscreenView();
      return root ? root.querySelector('[data-hook="nav-arrow-next"]') : null;
    },
    isNextDisabled(btn) {
      return isNextButtonDisabled(btn);
    },
    async getAllUrls() {
      const root = getWixProGalleryFullscreenView();
      const nextBtn = this.getNextButton();
      if (nextBtn) {
        console.log('Using step-through mode for Wix Pro Gallery for reliability.');
        return null;
      }

      const items = getWixProGalleryItemsFromOpenModal(root);
      if (!items.length) return null;

      const thumbCount = root ? root.querySelectorAll('.thumbnailItem[data-key]').length : 0;
      if (thumbCount > 1 && nextBtn && items.length < thumbCount) {
        console.log(`Wix Pro Gallery direct list incomplete (${items.length}/${thumbCount}); using step-through fallback.`);
        return null;
      }

      return items;
    },
    async waitForNext(previousUrl, timeoutMs = 10000) {
      return waitForGalleryMediaChange(this, previousUrl, timeoutMs);
    }
  };

  const bookingGalleryAdapter = {
    name: 'Booking.com Gallery',
    isOpen() {
      return !!getBookingSingleViewRoot();
    },
    getCurrentMediaEl() {
      const root = getBookingSingleViewRoot();
      if (!root) return null;

      const switcher = root.querySelector('[data-testid="gallery-single-view-image-switcher"]');
      if (switcher) {
        return findFirstSupportedMedia(switcher);
      }

      return findFirstSupportedMedia(root);
    },
    getCurrentUrl() {
      return getMediaUrlFromElement(this.getCurrentMediaEl());
    },
    getNextButton() {
      const root = getBookingSingleViewRoot();
      return root ? root.querySelector('[data-testid="gallery-single-view-slider-next-button"]') : null;
    },
    isNextDisabled(btn) {
      return isNextButtonDisabled(btn);
    },
    async getAllUrls() {
      const items = getBookingGalleryDomItems();
      if (!items.length) return null;

      const root = getBookingSingleViewRoot();
      const nextBtn = this.getNextButton();
      const counterInfo = getBookingGalleryCounterInfo(root);
      const thumbButtonCount = getBookingThumbnailButtonCount(root);

      if (nextBtn && !counterInfo) {
        console.log('Booking.com counter unavailable while navigation exists; using step-through fallback.');
        return null;
      }

      if (thumbButtonCount > 1 && nextBtn && items.length < thumbButtonCount) {
        console.log(`Booking.com direct list incomplete (${items.length}/${thumbButtonCount} thumbnail buttons); using step-through fallback.`);
        return null;
      }

      if (counterInfo && counterInfo.total > 1 && nextBtn && items.length < counterInfo.total) {
        console.log(`Booking.com direct list incomplete (${items.length}/${counterInfo.total}); using step-through fallback.`);
        return null;
      }

      return items;
    },
    async waitForNext(previousUrl, timeoutMs = 10000) {
      return waitForGalleryMediaChange(this, previousUrl, timeoutMs);
    }
  };

  const superYachtTimesAdapter = {
    name: 'SuperYacht Times Article Gallery',
    isOpen() {
      if (!isSuperYachtTimesHost()) return false;

      const nextData = getSuperYachtTimesNextData();
      const pageType = nextData && typeof nextData.page === 'string' ? nextData.page : '';
      if (pageType !== '/yacht-news/[articleSlug]') return false;

      return getSuperYachtTimesGalleryItems().length > 0;
    },
    getCurrentMediaEl() {
      return getSuperYachtTimesCurrentMediaElement();
    },
    getCurrentUrl() {
      return getMediaUrlFromElement(this.getCurrentMediaEl());
    },
    getNextButton() {
      return null;
    },
    isNextDisabled(btn) {
      return isNextButtonDisabled(btn);
    },
    async getAllUrls() {
      const items = getSuperYachtTimesGalleryItems();
      if (items.length) {
        console.log('Resolved SuperYacht Times gallery media from __NEXT_DATA__.');
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
    fraserGalleryAdapter,
    wixProGalleryAdapter,
    bookingGalleryAdapter,
    superYachtTimesAdapter,
    magnificPopupAdapter
  ];

  function getOpenGalleryAdapter() {
    return galleryAdapters.find((adapter) => adapter.isOpen()) || null;
  }

  function clearStatusHideTimer() {
    if (statusHideTimer) {
      window.clearTimeout(statusHideTimer);
      statusHideTimer = null;
    }
  }

  function ensureStatusElement() {
    let status = document.getElementById(STATUS_ID);
    if (status) return status;

    status = document.createElement('div');
    status.id = STATUS_ID;
    status.innerHTML = [
      '<div class="tm-status-title"></div>',
      '<div class="tm-status-bar"><div class="tm-status-bar-fill"></div></div>',
      '<div class="tm-status-meta"></div>'
    ].join('');

    document.body.appendChild(status);
    return status;
  }

  function setStatusIndicator(state) {
    ensureStyles();
    clearStatusHideTimer();

    const status = ensureStatusElement();
    const titleEl = status.querySelector('.tm-status-title');
    const fillEl = status.querySelector('.tm-status-bar-fill');
    const metaEl = status.querySelector('.tm-status-meta');

    const processed = Number.isFinite(state.processed) ? state.processed : 0;
    const total = Number.isFinite(state.total) && state.total > 0 ? state.total : null;
    const downloaded = Number.isFinite(state.downloaded) ? state.downloaded : 0;
    const skipped = Number.isFinite(state.skipped) ? state.skipped : 0;
    const failed = Number.isFinite(state.failed) ? state.failed : 0;
    const modeText = state.mode ? ` | ${state.mode}` : '';

    titleEl.textContent = state.title || 'Preparing download...';
    metaEl.textContent = total
      ? `${processed}/${total} processed | ${downloaded} downloaded | ${skipped} skipped | ${failed} failed${modeText}`
      : `${processed} processed | ${downloaded} downloaded | ${skipped} skipped | ${failed} failed${modeText}`;

    if (total) {
      const pct = Math.max(0, Math.min(100, Math.round((processed / total) * 100)));
      fillEl.style.width = `${pct}%`;
      status.classList.remove('is-indeterminate');
    } else {
      fillEl.style.width = '45%';
      status.classList.add('is-indeterminate');
    }

    status.classList.add('is-visible');
  }

  function hideStatusIndicator(delayMs = 0) {
    const hide = () => {
      const status = document.getElementById(STATUS_ID);
      if (status) {
        status.classList.remove('is-visible');
        status.classList.remove('is-indeterminate');
      }
    };

    clearStatusHideTimer();
    if (delayMs > 0) {
      statusHideTimer = window.setTimeout(hide, delayMs);
    } else {
      hide();
    }
  }

  function setButtonBusy(isBusy) {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;

    btn.disabled = !!isBusy;
    btn.textContent = isBusy ? 'Downloading...' : 'Download Open Gallery';
  }

  async function downloadByStepping(adapter, downloadSubdirectory = '', onProgress = null) {
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
      }, index, downloadSubdirectory);
      results.push(result);
      index++;
      if (typeof onProgress === 'function') {
        onProgress({
          result,
          processed: index,
          total: null
        });
      }

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
    if (runInProgress) {
      alert('A gallery download is already in progress.');
      return;
    }

    runInProgress = true;
    setButtonBusy(true);
    try {
      setStatusIndicator({
        title: 'Looking for supported open gallery...',
        processed: 0,
        total: null,
        downloaded: 0,
        skipped: 0,
        failed: 0,
        mode: 'waiting'
      });

      const adapter = await waitForSupportedGalleryOpen();
      if (!adapter) {
        hideStatusIndicator();
        alert(
          'No supported open gallery detected. Open a supported lightbox first ' +
          '(LightGallery, Webflow, Parvus, Fancybox, PhotoSwipe, FS Lightbox, GLightbox, Lightbox2, Fraser Gallery, Wix Pro Gallery, Booking.com, SuperYacht Times, or Magnific Popup).'
        );
        return;
      }

      const defaultSubdirectory = getDownloadSubdirectoryName();
      const downloadSubdirectory = chooseDownloadSubdirectory(defaultSubdirectory);
      if (!downloadSubdirectory) {
        hideStatusIndicator();
        alert('Download cancelled.');
        return;
      }

      if (!supportsSubfolderDownloadPaths()) {
        console.warn(
          `Tampermonkey download mode is "${getDownloadMode()}". Browser may ignore folder paths and save into Downloads root.`
        );
        alert(
          'Subfolder saving may be unavailable in current Tampermonkey download mode. ' +
          'Open Tampermonkey Dashboard -> Settings -> Downloads and use Browser API mode, then grant downloads permission. ' +
          'Your browser may still override filenames.'
        );
      }
      let downloaded = 0;
      let skipped = 0;
      let failed = 0;

      const onProgress = ({ result, processed, total }) => {
        if (result.status === 'downloaded') downloaded += 1;
        if (result.status === 'skipped') skipped += 1;
        if (result.status === 'failed') failed += 1;

        setStatusIndicator({
          title: `Downloading from ${adapter.name}`,
          processed,
          total,
          downloaded,
          skipped,
          failed,
          mode: total ? 'direct list' : 'step-through'
        });
      };

      let results = [];
      const directItems = await adapter.getAllUrls();
      if (directItems && directItems.length) {
        const directTotal = uniqueMediaItems(directItems).length;
        setStatusIndicator({
          title: `Downloading from ${adapter.name}`,
          processed: 0,
          total: directTotal,
          downloaded: 0,
          skipped: 0,
          failed: 0,
          mode: 'direct list'
        });

        results = await downloadMediaItems(directItems, downloadSubdirectory, onProgress);
      } else {
        setStatusIndicator({
          title: `Downloading from ${adapter.name}`,
          processed: 0,
          total: null,
          downloaded: 0,
          skipped: 0,
          failed: 0,
          mode: 'step-through'
        });

        results = await downloadByStepping(adapter, downloadSubdirectory, onProgress);
      }

      const counts = summarizeResults(results);
      setStatusIndicator({
        title: `Done (${adapter.name})`,
        processed: results.length,
        total: results.length || null,
        downloaded: counts.downloaded,
        skipped: counts.skipped,
        failed: counts.failed,
        mode: `folder: ${downloadSubdirectory}`
      });

      hideStatusIndicator(5000);
      alert(
        `Done. ${counts.downloaded} downloaded, ${counts.skipped} skipped, ${counts.failed} failed from ${adapter.name}. ` +
        `Saved under Downloads/${downloadSubdirectory}/`
      );
      console.log('Download results:', results);
    } catch (error) {
      console.error('Gallery downloader failed unexpectedly:', error);
      setStatusIndicator({
        title: 'Download stopped unexpectedly',
        processed: 0,
        total: null,
        downloaded: 0,
        skipped: 0,
        failed: 0,
        mode: 'error'
      });
      hideStatusIndicator(6000);
      alert('Unexpected error while downloading. Check the browser console for details.');
    } finally {
      runInProgress = false;
      setButtonBusy(false);
    }
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

      #${BTN_ID}:disabled {
        opacity: 0.7;
        cursor: default;
      }

      #${STATUS_ID} {
        position: fixed;
        top: 60px;
        right: 16px;
        z-index: 2147483647;
        width: min(330px, calc(100vw - 32px));
        border-radius: 10px;
        border: 1px solid rgba(0, 0, 0, 0.12);
        background: rgba(255, 255, 255, 0.96);
        color: #111;
        padding: 10px 12px;
        font: 12px/1.35 sans-serif;
        box-shadow: 0 8px 20px rgba(0, 0, 0, 0.15);
        opacity: 0;
        transform: translateY(-4px);
        transition: opacity 160ms ease, transform 160ms ease;
        pointer-events: none;
      }

      #${STATUS_ID}.is-visible {
        opacity: 1;
        transform: translateY(0);
      }

      #${STATUS_ID} .tm-status-title {
        font-weight: 600;
        margin-bottom: 7px;
      }

      #${STATUS_ID} .tm-status-bar {
        width: 100%;
        height: 6px;
        border-radius: 999px;
        background: #e5e5e5;
        overflow: hidden;
        margin-bottom: 7px;
      }

      #${STATUS_ID} .tm-status-bar-fill {
        height: 100%;
        width: 0;
        background: #111;
        transition: width 180ms ease;
      }

      #${STATUS_ID}.is-indeterminate .tm-status-bar-fill {
        animation: tm-gallery-status-indeterminate 1.1s ease-in-out infinite;
      }

      #${STATUS_ID} .tm-status-meta {
        color: #333;
      }

      @keyframes tm-gallery-status-indeterminate {
        0% {
          transform: translateX(-120%);
        }
        100% {
          transform: translateX(260%);
        }
      }
    `);
  }

  function addButton() {
    if (document.getElementById(BTN_ID)) return;

    ensureStyles();

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.textContent = runInProgress ? 'Downloading...' : 'Download Open Gallery';
    btn.disabled = runInProgress;
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
