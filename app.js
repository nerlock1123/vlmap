
(() => {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const branches = window.CYBERMG_BRANCHES || [];
  const PRIMARY_KEY = cfg.DGIS_KEY_PRIMARY || cfg.DGIS_KEY || '';
  const BACKUP_KEY_1 = window.DGIS_BACKUP_KEY_1 || '';
  const BACKUP_KEY_2 = window.DGIS_BACKUP_KEY_2 || '';

  const allowedKeyModes = new Set(['primary', 'backup1', 'backup2']);
  const KEY_MODE = allowedKeyModes.has(cfg.DGIS_KEY_MODE)
    ? cfg.DGIS_KEY_MODE
    : 'primary';

  const isUsableKey = (value) =>
    value &&
    !value.startsWith('PASTE_BACKUP_') &&
    value !== 'PASTE_SECOND_2GIS_KEY_HERE';

  let API_KEY = PRIMARY_KEY;

  if (KEY_MODE === 'backup1' && isUsableKey(BACKUP_KEY_1)) {
    API_KEY = BACKUP_KEY_1;
  } else if (KEY_MODE === 'backup2' && isUsableKey(BACKUP_KEY_2)) {
    API_KEY = BACKUP_KEY_2;
  }
  const CITY = cfg.CITY_NAME || 'Владивосток';
  const CITY_CENTER = cfg.CITY_CENTER || [131.900, 43.132];
  const CITY_ZOOM = cfg.CITY_ZOOM || 10.85;

  const $ = (id) => document.getElementById(id);

  if (!API_KEY || !window.mapgl) {
    $('fatalError').classList.remove('hidden');
    $('fatalMessage').textContent = !API_KEY
      ? 'Не найден ключ 2ГИС.'
      : 'Не загрузилась библиотека MapGL.';
    return;
  }

  let map;

  const safeMapOptions = {
    key: API_KEY,
    center: CITY_CENTER,
    zoom: CITY_ZOOM,
    zoomControl: 'bottomRight',
    enableTrackResize: true,
    disableRotationByUserInteraction: false,
    disablePitchByUserInteraction: true,
    graphicsPreset: 'auto'
  };

  try {
    map = new mapgl.Map('map', {
      ...safeMapOptions,

      // v9 HOTFIX:
      // MapGL LngLatBounds must be an object with southWest / northEast.
      minZoom: 10.2,
      maxZoom: 18.0,
      maxBounds: {
        southWest: [131.78, 43.02],
        northEast: [132.03, 43.23]
      }
    });
  } catch (error) {
    console.error('Optimized MapGL init failed, using safe fallback:', error);

    // Never leave the user with a blank page because of an optional
    // optimization. Fall back to the last known-good map configuration.
    try {
      map = new mapgl.Map('map', safeMapOptions);
    } catch (fallbackError) {
      console.error('MapGL fallback init failed:', fallbackError);
      $('fatalError').classList.remove('hidden');
      $('fatalMessage').textContent =
        'Не удалось запустить карту 2ГИС. Обновите страницу или проверьте ключ/API.';
      return;
    }
  }

  let branchMarkers = [];
  let selectionMarker = null;
  let searchAbort = null;
  let searchTimer = null;
  let toastTimer = null;

  // v10 live browser geolocation. No 2GIS Places/Markers requests are used here.
  let geoWatchId = null;
  let liveLocationMarker = null;
  let liveLocationActive = false;
  let followLocation = false;
  let lastLiveCoords = null;
  let lastCameraFollowAt = 0;
  const FOLLOW_MIN_INTERVAL_MS = 1200;
  const FOLLOW_EDGE_RATIO_X = 0.28;
  const FOLLOW_EDGE_RATIO_Y = 0.30;

  // v8 Smart POI layer.
  // Background POIs use Markers API, NOT Places API.
  let poiVisible = false;
  let poiMarkers = [];
  let poiTimer = null;
  let poiAbort = null;
  let lastPoiKey = '';
  let markerApiRequestsThisSession = 0;
  const MAX_MARKER_API_REQUESTS_PER_SESSION = 60;
  const POI_CACHE_PREFIX = 'mapdozor-poi-v8:';
  const POI_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
  const CITY_ID_CACHE_KEY = 'mapdozor-vladivostok-city-id-v8';

  function destroyAll(list) {
    list.forEach((obj) => {
      try { obj.destroy(); } catch (_) {}
    });
    list.length = 0;
  }

  function openBranch(branch) {
    showInfo({
      coords: branch.coordinates,
      title: `CYBERMG ${branch.name}`,
      address: branch.address,
      type: 'branch',
      branch
    });
  }

  function addBranchLabel(branch, zIndex) {
    if (typeof mapgl.Label !== 'function') return null;

    const [offsetX = 18, offsetY = -12] = branch.labelOffset || [];
    const relativeAnchor = offsetX < 0
      ? [1, 0.5]
      : offsetX > 0
        ? [0, 0.5]
        : [0.5, offsetY > 0 ? 0 : 1];

    const baseOptions = {
      coordinates: branch.coordinates,
      text: `CYBERMG\n${branch.name}`,
      color: '#111111',
      fontSize: 13,
      lineHeight: 1.05,
      haloColor: '#FFC600',
      haloRadius: 5,
      offset: [offsetX, offsetY],
      relativeAnchor,
      interactive: true,
      zIndex
    };

    let label;
    try {
      // Current MapGL: keep our six labels outside the collision engine.
      label = new mapgl.Label(map, {
        ...baseOptions,
        labeling: { type: 'none' }
      });
    } catch (error) {
      console.warn('MapGL Label labeling option is unavailable; using plain label:', error);
      label = new mapgl.Label(map, baseOptions);
    }

    label.on('click', (event) => {
      if (event?.originalEvent) {
        event.originalEvent.preventDefault?.();
        event.originalEvent.stopPropagation?.();
      }
      openBranch(branch);
    });

    return label;
  }

  function addBranchDot(branch, zIndex) {
    let marker;

    // Prefer the native WebGL circle. Unlike the previous 0x0 HTML marker,
    // this does not depend on DOM sizing and is reliably rendered by MapGL.
    if (typeof mapgl.CircleMarker === 'function') {
      marker = new mapgl.CircleMarker(map, {
        coordinates: branch.coordinates,
        diameter: 30,
        color: '#FFC600',
        strokeColor: '#111111',
        strokeWidth: 4,
        interactive: true,
        zIndex
      });
    } else {
      // Very old MapGL fallback: a standard native marker is still preferable
      // to hiding the branch completely.
      marker = new mapgl.Marker(map, {
        coordinates: branch.coordinates,
        interactive: true,
        zIndex
      });
    }

    marker.on('click', () => openBranch(branch));
    return marker;
  }

  function renderBranches() {
    destroyAll(branchMarkers);

    if (!branches.length) {
      console.error('CYBERMG branches were not loaded. Check branches.js.');
      showToast('Не загрузились данные 6 филиалов CYBERMG', 6000);
      return;
    }

    branches.forEach((branch, index) => {
      const zIndex = 220 + index * 2;

      try {
        const dot = addBranchDot(branch, zIndex);
        if (dot) branchMarkers.push(dot);

        const label = addBranchLabel(branch, zIndex + 1);
        if (label) branchMarkers.push(label);
      } catch (error) {
        console.error(`Failed to render CYBERMG branch ${branch.name}:`, error);

        // Last-resort native marker. One broken label must never remove a branch.
        try {
          const fallback = new mapgl.Marker(map, {
            coordinates: branch.coordinates,
            interactive: true,
            zIndex: zIndex + 5
          });
          fallback.on('click', () => openBranch(branch));
          branchMarkers.push(fallback);
        } catch (fallbackError) {
          console.error(`Fallback marker failed for ${branch.name}:`, fallbackError);
        }
      }
    });

    console.info(`CYBERMG: rendered ${branches.length} branches (${branchMarkers.length} map objects).`);
  }

  function clearPoiMarkers() {
    destroyAll(poiMarkers);
  }

  function poiProfileForZoom(zoom) {
    // No custom businesses at city overview: the map stays clean.
    if (zoom < 13.3) return null;

    if (zoom < 14.3) {
      return { bucket: 'z13', radius: 1800, count: 8, cellLon: 0.020, cellLat: 0.014, labels: false };
    }
    if (zoom < 15.3) {
      return { bucket: 'z14', radius: 1200, count: 14, cellLon: 0.012, cellLat: 0.008, labels: true };
    }
    if (zoom < 16.3) {
      return { bucket: 'z15', radius: 800, count: 20, cellLon: 0.007, cellLat: 0.005, labels: true };
    }
    return { bucket: 'z16', radius: 500, count: 28, cellLon: 0.004, cellLat: 0.003, labels: true };
  }

  function snapToCell(value, size) {
    return Math.round(value / size) * size;
  }

  function poiCacheKey(center, profile) {
    const lon = snapToCell(center[0], profile.cellLon).toFixed(5);
    const lat = snapToCell(center[1], profile.cellLat).toFixed(5);
    return `${profile.bucket}:${lon}:${lat}`;
  }

  function readPoiCache(key) {
    try {
      const raw = sessionStorage.getItem(POI_CACHE_PREFIX + key);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (!entry?.ts || !Array.isArray(entry.items)) return null;
      if (Date.now() - entry.ts > POI_CACHE_TTL) {
        sessionStorage.removeItem(POI_CACHE_PREFIX + key);
        return null;
      }
      return entry.items;
    } catch (_) {
      return null;
    }
  }

  function writePoiCache(key, items) {
    try {
      sessionStorage.setItem(
        POI_CACHE_PREFIX + key,
        JSON.stringify({ ts: Date.now(), items })
      );
    } catch (_) {}
  }

  function truncatePoiName(name, max = 24) {
    const text = String(name || 'Организация').trim();
    return text.length > max ? text.slice(0, max - 1) + '…' : text;
  }

  function renderPoiMarkers(items, profile) {
    clearPoiMarkers();
    if (!poiVisible || !profile) return;

    items.slice(0, profile.count).forEach((item) => {
      const lon = Number(item.lon);
      const lat = Number(item.lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;

      const options = {
        coordinates: [lon, lat],
        zIndex: 35,
      };

      // Use native MapGL/WebGL labels rather than HTML markers.
      // Labels appear only at closer zooms to avoid clutter.
      if (profile.labels && item.name) {
        options.label = {
          text: truncatePoiName(item.name),
          offset: [0, 22],
          relativeAnchor: [0.5, 0],
        };
      }

      const marker = new mapgl.Marker(map, options);
      marker.on('click', () => {
        const coords = [lon, lat];
        setMarker(coords);
        showInfo({
          coords,
          title: item.name || 'Организация',
          address: 'Организация из слоя 2ГИС',
          type: item.type || 'branch',
          id: item.id
        });
      });

      poiMarkers.push(marker);
    });
  }

  async function getVladivostokCityId() {
    try {
      const cached = localStorage.getItem(CITY_ID_CACHE_KEY);
      if (cached) return cached;
    } catch (_) {}

    if (markerApiRequestsThisSession >= MAX_MARKER_API_REQUESTS_PER_SESSION) {
      return null;
    }

    const url = new URL('https://catalog.api.2gis.com/3.0/markers');
    url.searchParams.set('q', CITY);
    url.searchParams.set('type', 'adm_div.city');
    url.searchParams.set('location', `${CITY_CENTER[0]},${CITY_CENTER[1]}`);
    url.searchParams.set('page_size', '5');
    url.searchParams.set('locale', 'ru_RU');
    url.searchParams.set('fields', 'items.name');
    url.searchParams.set('key', API_KEY);

    markerApiRequestsThisSession += 1;
    const data = await apiJson(url);
    const items = data?.result?.items || [];
    const city =
      items.find((x) => String(x.name || '').toLowerCase().includes('владивосток')) ||
      items[0];

    if (!city?.id) return null;

    const id = String(city.id).split('_')[0];
    try { localStorage.setItem(CITY_ID_CACHE_KEY, id); } catch (_) {}
    return id;
  }

  async function fetchNearbyPoi(center, profile, signal) {
    if (markerApiRequestsThisSession >= MAX_MARKER_API_REQUESTS_PER_SESSION) {
      return [];
    }

    const cityId = await getVladivostokCityId();
    if (!cityId) return [];

    const url = new URL('https://catalog.api.2gis.com/3.0/markers');

    // Markers API supports search without a text query when the search
    // is restricted to a city. We ask for nearby company branches.
    url.searchParams.set('city_id', cityId);
    url.searchParams.set('type', 'branch');
    url.searchParams.set('point', `${center[0]},${center[1]}`);
    url.searchParams.set('location', `${center[0]},${center[1]}`);
    url.searchParams.set('radius', String(profile.radius));
    url.searchParams.set('sort', 'rating');
    url.searchParams.set('search_nearby', 'true');
    url.searchParams.set('page_size', String(profile.count));
    url.searchParams.set('locale', 'ru_RU');
    url.searchParams.set('fields', 'items.name');
    url.searchParams.set('key', API_KEY);

    markerApiRequestsThisSession += 1;
    const data = await apiJson(url, signal);
    return (data?.result?.items || []).filter(
      (item) => Number.isFinite(Number(item.lon)) && Number.isFinite(Number(item.lat))
    );
  }

  async function refreshPoiLayer() {
    if (!poiVisible) {
      clearPoiMarkers();
      return;
    }

    const zoom = map.getZoom();
    const profile = poiProfileForZoom(zoom);

    if (!profile) {
      lastPoiKey = '';
      clearPoiMarkers();
      return;
    }

    const center = map.getCenter();
    const key = poiCacheKey(center, profile);

    // Same zoom/cell: no API request and no rerender.
    if (key === lastPoiKey && poiMarkers.length) return;
    lastPoiKey = key;

    const cached = readPoiCache(key);
    if (cached) {
      renderPoiMarkers(cached, profile);
      return;
    }

    if (markerApiRequestsThisSession >= MAX_MARKER_API_REQUESTS_PER_SESSION) {
      // Hard guard against accidentally burning the demo quota during tests.
      return;
    }

    if (poiAbort) poiAbort.abort();
    poiAbort = new AbortController();

    try {
      const items = await fetchNearbyPoi(center, profile, poiAbort.signal);
      writePoiCache(key, items);
      renderPoiMarkers(items, profile);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      console.warn('Smart POI layer unavailable:', err);

      // Do not spam the API if this configuration is unavailable.
      clearPoiMarkers();
    }
  }

  function schedulePoiRefresh(delay = 450) {
    clearTimeout(poiTimer);
    poiTimer = setTimeout(refreshPoiLayer, delay);
  }

  // Boundary-aware point-on-segment check.
  function distanceKm(a, b) {
    const toRad = (value) => value * Math.PI / 180;
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const dLat = lat2 - lat1;
    const dLon = toRad(b[0] - a[0]);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function nearestBranch(coords) {
    if (!branches.length) return null;

    return branches.reduce((best, branch) => {
      const distance = distanceKm(coords, branch.coordinates);
      if (!best || distance < best.distance) return { branch, distance };
      return best;
    }, null);
  }

  function formatDistance(distance) {
    if (!Number.isFinite(distance)) return '';
    if (distance < 1) return `${Math.max(10, Math.round(distance * 1000 / 10) * 10)} м`;
    return `${distance.toFixed(distance < 10 ? 1 : 0)} км`;
  }


  function liveMarkerHtml() {
    return `
      <div class="live-location-marker" aria-hidden="true">
        <div class="live-location-core"></div>
      </div>`;
  }

  function setLiveLocationMarker(coords) {
    if (!liveLocationMarker) {
      liveLocationMarker = new mapgl.HtmlMarker(map, {
        coordinates: coords,
        html: liveMarkerHtml(),
        interactive: false,
        preventMapInteractions: false,
        zIndex: 250
      });
      return;
    }

    liveLocationMarker.setCoordinates(coords);
  }

  function removeLiveLocationMarker() {
    if (!liveLocationMarker) return;
    try { liveLocationMarker.destroy(); } catch (_) {}
    liveLocationMarker = null;
  }

  function formatLiveSpeed(speedMps) {
    if (!Number.isFinite(speedMps) || speedMps < 0.4) return '';
    const kmh = Math.round(speedMps * 3.6);
    return `${kmh} км/ч`;
  }

  function updateLiveStatus(position) {
    const coords = [position.coords.longitude, position.coords.latitude];
    const nearest = nearestBranch(coords);
    const accuracy = Math.max(1, Math.round(position.coords.accuracy || 0));
    const speed = formatLiveSpeed(position.coords.speed);

    $('liveBranchText').textContent = nearest
      ? `${nearest.branch.name} · ${formatDistance(nearest.distance)}`
      : 'GPS';

    $('liveAccuracyText').textContent = `±${accuracy} м`;
    $('liveSpeedText').textContent = speed ? `• ${speed}` : '';
    $('liveLocationStatus').classList.remove('hidden');
  }

  function shouldFollowCamera(coords) {
    if (!followLocation) return false;

    const now = Date.now();
    if (now - lastCameraFollowAt < FOLLOW_MIN_INTERVAL_MS) return false;

    try {
      const pixel = map.project(coords);
      const el = $('map');
      const w = el.clientWidth || window.innerWidth;
      const h = el.clientHeight || window.innerHeight;

      if (!w || !h || !pixel) return true;

      const minX = w * FOLLOW_EDGE_RATIO_X;
      const maxX = w * (1 - FOLLOW_EDGE_RATIO_X);
      const minY = h * FOLLOW_EDGE_RATIO_Y;
      const maxY = h * (1 - FOLLOW_EDGE_RATIO_Y);

      return pixel[0] < minX || pixel[0] > maxX || pixel[1] < minY || pixel[1] > maxY;
    } catch (_) {
      return true;
    }
  }

  function followCameraIfNeeded(coords, force = false) {
    if (!followLocation) return;
    if (!force && !shouldFollowCamera(coords)) return;

    lastCameraFollowAt = Date.now();
    map.setCenter(coords, {
      animate: true,
      duration: force ? 300 : 450
    });

    // Keep a useful navigation zoom without forcing a zoom change on every GPS update.
    if (force && map.getZoom() < 15) {
      map.setZoom(16, { animate: true, duration: 300 });
    }
  }

  function handleLivePosition(position) {
    const coords = [position.coords.longitude, position.coords.latitude];

    if (!Number.isFinite(coords[0]) || !Number.isFinite(coords[1])) return;

    lastLiveCoords = coords;
    setLiveLocationMarker(coords);
    updateLiveStatus(position);
    followCameraIfNeeded(coords, false);
  }

  function handleLiveLocationError(err) {
    const messages = {
      1: 'Доступ к геопозиции запрещён',
      2: 'Не удалось определить геопозицию',
      3: 'Истекло время определения геопозиции',
    };
    showToast(messages[err.code] || 'Ошибка геолокации');
  }

  function startLiveLocation() {
    if (!navigator.geolocation) {
      showToast('Геолокация не поддерживается этим браузером');
      return;
    }

    if (liveLocationActive) return;

    liveLocationActive = true;
    $('locateBtn').classList.add('active');
    $('followBtn').disabled = false;
    showToast('GPS включён. Определяю местоположение…', 3500);

    geoWatchId = navigator.geolocation.watchPosition(
      (position) => {
        const firstFix = !lastLiveCoords;
        handleLivePosition(position);

        if (firstFix && lastLiveCoords) {
          followLocation = true;
          $('followBtn').classList.add('active');
          followCameraIfNeeded(lastLiveCoords, true);
          const nearest = nearestBranch(lastLiveCoords);
          showToast(nearest
            ? `GPS включён · ближе всего ${nearest.branch.name}`
            : 'GPS включён');
        }
      },
      handleLiveLocationError,
      {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 3000
      }
    );
  }

  function stopLiveLocation() {
    if (geoWatchId !== null && navigator.geolocation) {
      navigator.geolocation.clearWatch(geoWatchId);
    }

    geoWatchId = null;
    liveLocationActive = false;
    followLocation = false;
    lastLiveCoords = null;

    $('locateBtn').classList.remove('active');
    $('followBtn').classList.remove('active');
    $('followBtn').disabled = true;
    $('liveLocationStatus').classList.add('hidden');

    removeLiveLocationMarker();
    showToast('GPS выключен');
  }

  function setMarker(coords) {
    if (selectionMarker) {
      try { selectionMarker.destroy(); } catch (_) {}
    }
    selectionMarker = new mapgl.Marker(map, { coordinates: coords, zIndex: 100 });
  }

  function showToast(message, ms = 2300) {
    clearTimeout(toastTimer);
    const toast = $('statusToast');
    toast.textContent = message;
    toast.classList.remove('hidden');
    toastTimer = setTimeout(() => toast.classList.add('hidden'), ms);
  }

  function typeLabel(type) {
    const labels = {
      branch: 'Организация',
      building: 'Здание',
      attraction: 'Место',
      street: 'Улица',
      route: 'Маршрут',
      station: 'Остановка',
    };
    return labels[type] || (type ? 'Объект 2ГИС' : 'Точка на карте');
  }

  function build2GisUrl({ id, type, coords }) {
    const safeId = id ? encodeURIComponent(String(id)) : '';

    // Official 2GIS deep-link / universal-link patterns.
    if (safeId) {
      if (type === 'branch') return `https://2gis.ru/firm/${safeId}`;
      if (type === 'stop') return `https://2gis.ru/stop/${safeId}`;
      if (type === 'platform') return `https://2gis.ru/platform/${safeId}`;
      if (type === 'route') return `https://2gis.ru/route/${safeId}`;
      if (type === 'stationEntrance') return `https://2gis.ru/stationEntrance/${safeId}`;
      return `https://2gis.ru/geo/${safeId}`;
    }

    // Any arbitrary selected point can still be opened in 2GIS.
    return `https://2gis.ru/geo/${coords[0].toFixed(6)},${coords[1].toFixed(6)}`;
  }

  function showInfo({ coords, title, address, type, id, branch = null }) {
    const nearest = branch ? { branch, distance: 0 } : nearestBranch(coords);
    const badge = $('branchBadge');

    badge.textContent = branch ? `CYBERMG · ${branch.name}` : 'CYBERMG';
    badge.style.background = '#FFC600';
    badge.style.color = '#111';

    $('objectType').textContent = branch ? 'Филиал CYBERMG' : typeLabel(type);
    $('sheetTitle').textContent = title || 'Точка на карте';
    $('sheetAddress').textContent = address || 'Без адреса';
    $('sheetBranch').textContent = nearest
      ? `${nearest.branch.name}${branch ? '' : ` · ${formatDistance(nearest.distance)}`}`
      : '—';
    $('sheetCoords').textContent = `${coords[1].toFixed(6)}, ${coords[0].toFixed(6)}`;
    $('open2gisBtn').href = build2GisUrl({ id, type, coords });

    $('infoSheet').classList.remove('hidden');
    document.body.classList.add('sheet-open');
  }

  function hideInfo() {
    $('infoSheet').classList.add('hidden');
    document.body.classList.remove('sheet-open');
  }

  function coordsFromItem(item) {
    if (item?.point && Number.isFinite(item.point.lon) && Number.isFinite(item.point.lat)) {
      return [item.point.lon, item.point.lat];
    }
    const centroid = item?.geometry?.centroid;
    if (typeof centroid === 'string') {
      const m = centroid.match(/POINT\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i);
      if (m) return [Number(m[1]), Number(m[2])];
    }
    return null;
  }

  function itemAddress(item) {
    return item?.full_address_name || item?.address_name || item?.address?.name || '';
  }

  async function apiJson(url, signal) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data?.meta?.code && data.meta.code !== 200) {
      throw new Error(data?.meta?.error?.message || `API ${data.meta.code}`);
    }
    return data;
  }

  async function fetchObjectById(id) {
    const url = new URL('https://catalog.api.2gis.com/3.0/items/byid');
    url.searchParams.set('id', id);
    url.searchParams.set('key', API_KEY);
    url.searchParams.set('locale', 'ru_RU');
    url.searchParams.set('fields', 'items.point,items.address,items.full_address_name,items.rubrics');
    const data = await apiJson(url);
    return data?.result?.items?.[0] || null;
  }

  async function searchPlaces(query) {
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();

    const url = new URL('https://catalog.api.2gis.com/3.0/items');
    url.searchParams.set('q', query);
    url.searchParams.set('location', `${CITY_CENTER[0]},${CITY_CENTER[1]}`);
    url.searchParams.set('page_size', '10');
    url.searchParams.set('locale', 'ru_RU');
    url.searchParams.set('fields', 'items.point,items.geometry.centroid,items.full_address_name');
    url.searchParams.set('key', API_KEY);

    const data = await apiJson(url, searchAbort.signal);
    return (data?.result?.items || []).filter((item) => coordsFromItem(item));
  }

  function renderSearchResults(items) {
    const box = $('searchResults');
    if (!items.length) {
      box.innerHTML = `<div class="result-item"><span class="result-address">Ничего не найдено во Владивостоке</span></div>`;
      box.classList.remove('hidden');
      return;
    }

    box.innerHTML = items.map((item, idx) => {
      const name = escapeHtml(item.name || item.full_name || item.address_name || 'Объект');
      const address = escapeHtml(itemAddress(item) || item.purpose_name || '');
      return `
        <button class="result-item" type="button" data-result-index="${idx}">
          <span class="result-name">${name}</span>
          <span class="result-address">${address}</span>
        </button>`;
    }).join('');

    box.classList.remove('hidden');
    box.querySelectorAll('[data-result-index]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const item = items[Number(btn.dataset.resultIndex)];
        selectSearchItem(item);
      });
    });
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function selectSearchItem(item) {
    const coords = coordsFromItem(item);
    if (!coords) return;

    setMarker(coords);
    map.setCenter(coords);
    map.setZoom(16);

    $('searchInput').value = item.name || item.address_name || item.full_name || '';
    $('clearSearchBtn').classList.remove('hidden');
    $('searchResults').classList.add('hidden');

    showInfo({
      coords,
      title: item.name || item.address_name || item.full_name || 'Результат поиска',
      address: itemAddress(item),
      type: item.type,
      id: item.id
    });
  }

  async function runSearch(query) {
    query = query.trim();
    if (query.length < 2) {
      $('searchResults').classList.add('hidden');
      return;
    }

    $('searchResults').innerHTML =
      `<div class="result-item"><span class="result-address">Ищу…</span></div>`;
    $('searchResults').classList.remove('hidden');

    try {
      const items = await searchPlaces(query);
      renderSearchResults(items);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      console.error(err);
      $('searchResults').innerHTML =
        `<div class="result-item"><span class="result-address">Не удалось выполнить поиск. Проверьте доступ Places API.</span></div>`;
      $('searchResults').classList.remove('hidden');
    }
  }

  $('searchInput').addEventListener('input', (e) => {
    const value = e.target.value;
    $('clearSearchBtn').classList.toggle('hidden', !value);
    clearTimeout(searchTimer);
    if (value.trim().length < 2) {
      $('searchResults').classList.add('hidden');
      return;
    }
    searchTimer = setTimeout(() => runSearch(value), 350);
  });

  $('searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchTimer);
      runSearch(e.currentTarget.value);
    }
  });

  $('clearSearchBtn').addEventListener('click', () => {
    $('searchInput').value = '';
    $('clearSearchBtn').classList.add('hidden');
    $('searchResults').classList.add('hidden');
    $('searchInput').focus();
  });

  document.addEventListener('click', (e) => {
    const marker = e.target.closest('[data-branch-id]');
    if (marker) {
      const branch = branches.find((item) => item.id === marker.dataset.branchId);
      if (branch) {
        e.preventDefault();
        e.stopPropagation();
        showInfo({
          coords: branch.coordinates,
          title: `CYBERMG ${branch.name}`,
          address: branch.address,
          type: 'branch',
          branch
        });
      }
      return;
    }

    if (!e.target.closest('.search-shell')) {
      $('searchResults').classList.add('hidden');
    }
  });

  $('homeBtn').addEventListener('click', () => {
    followLocation = false;
    $('followBtn').classList.remove('active');
    map.setCenter(CITY_CENTER);
    map.setZoom(CITY_ZOOM);
    hideInfo();
  });

  $('togglePoiBtn').addEventListener('click', () => {
    poiVisible = !poiVisible;
    $('togglePoiBtn').classList.toggle('active', poiVisible);

    if (!poiVisible) {
      if (poiAbort) poiAbort.abort();
      clearTimeout(poiTimer);
      clearPoiMarkers();
      return;
    }

    lastPoiKey = '';
    schedulePoiRefresh(0);
  });

  $('locateBtn').addEventListener('click', () => {
    if (liveLocationActive) {
      stopLiveLocation();
    } else {
      startLiveLocation();
    }
  });

  $('followBtn').addEventListener('click', () => {
    if (!liveLocationActive || !lastLiveCoords) return;

    followLocation = !followLocation;
    $('followBtn').classList.toggle('active', followLocation);

    if (followLocation) {
      followCameraIfNeeded(lastLiveCoords, true);
      showToast('Следование за GPS включено');
    } else {
      showToast('Карта свободна — GPS продолжает работать');
    }
  });

  $('closeSheetBtn').addEventListener('click', hideInfo);

  map.on('click', async (event) => {
    $('searchResults').classList.add('hidden');
    const coords = event.lngLat;
    if (!coords || coords.length < 2) return;

    setMarker(coords);

    const targetId = event.target?.id || event.targetData?.id;
    if (!targetId) {
      showInfo({
        coords,
        title: 'Точка на карте',
        address: 'Нажмите на здание или организацию, чтобы увидеть данные 2ГИС',
        type: ''
      });
      return;
    }

    // Immediately show the selected point, then enrich the card with 2GIS object details.
    showInfo({
      coords,
      title: 'Загружаю объект…',
      address: '',
      type: event.targetData?.type,
      id: targetId
    });

    try {
      const item = await fetchObjectById(targetId);
      if (!item) {
        showInfo({ coords, title: 'Объект на карте', address: '', type: event.targetData?.type, id: targetId });
        return;
      }

      const objectCoords = coordsFromItem(item) || coords;
      showInfo({
        coords: objectCoords,
        title: item.name || item.address_name || item.full_name || 'Объект 2ГИС',
        address: itemAddress(item),
        type: item.type,
        id: item.id || targetId
      });
    } catch (err) {
      console.warn('2GIS object details unavailable:', err);
      showInfo({
        coords,
        title: 'Объект на карте',
        address: 'Не удалось загрузить подробности объекта 2ГИС',
        type: event.targetData?.type,
        id: targetId
      });
    }
  });

  // Only refresh after MapGL is fully idle. No Places/Markers requests occur
  // continuously during drag, pinch, rotation or pitch.
  map.on('idle', () => schedulePoiRefresh(450));

  renderBranches();

  // Smart POI intentionally does NOT start automatically.
  // The first Markers API request happens only after the user taps “Места”.
  clearPoiMarkers();

  // PWA: safe enhancement; app still works without service worker.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
