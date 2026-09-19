
(() => {
  'use strict';

  const cfg = window.APP_CONFIG || {};
  const sectors = window.SECTORS || [];
  const API_KEY = cfg.DGIS_KEY;
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

  const map = new mapgl.Map('map', {
    key: API_KEY,
    center: CITY_CENTER,
    zoom: CITY_ZOOM,
    zoomControl: 'bottomRight',
    enableTrackResize: true,

    // v9 tile-saving constraints:
    // rotation stays available, but 3D pitch is disabled.
    disableRotationByUserInteraction: false,
    disablePitchByUserInteraction: true,

    // Prevent accidental loading of very distant / extremely detailed tile sets.
    minZoom: 10.2,
    maxZoom: 18.0,

    // Keep the map around Vladivostok + a safe buffer around all sectors.
    // Format: [[west, south], [east, north]]
    maxBounds: [
      [131.78, 43.02],
      [132.03, 43.23]
    ],

    // Let MapGL choose rendering complexity for the device.
    graphicsPreset: 'auto'
  });

  let sectorObjects = [];
  let sectorLabels = [];
  let sectorsVisible = true;
  let selectionMarker = null;
  let searchAbort = null;
  let searchTimer = null;
  let toastTimer = null;

  // v8 Smart POI layer.
  // Background POIs use Markers API, NOT Places API.
  let poiVisible = true;
  let poiMarkers = [];
  let poiTimer = null;
  let poiAbort = null;
  let lastPoiKey = '';
  let markerApiRequestsThisSession = 0;
  const MAX_MARKER_API_REQUESTS_PER_SESSION = 60;
  const POI_CACHE_PREFIX = 'mapdozor-poi-v8:';
  const POI_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours
  const CITY_ID_CACHE_KEY = 'mapdozor-vladivostok-city-id-v8';

  function polygonRing(points) {
    return [[...points, points[0]]];
  }

  function sectorCenter(points) {
    return [
      points.reduce((sum, p) => sum + p[0], 0) / points.length,
      points.reduce((sum, p) => sum + p[1], 0) / points.length,
    ];
  }

  function destroyAll(list) {
    list.forEach((obj) => {
      try { obj.destroy(); } catch (_) {}
    });
    list.length = 0;
  }

  function renderLegend() {
    $('legend').innerHTML = sectors.map((s) => `
      <div class="legend-pill">
        <span class="legend-dot" style="background:${s.color}"></span>
        ${s.name}
      </div>
    `).join('');
  }

  function renderSectors() {
    destroyAll(sectorObjects);
    destroyAll(sectorLabels);
    if (!sectorsVisible) return;

    sectors.forEach((sector) => {
      sectorObjects.push(new mapgl.Polygon(map, {
        coordinates: polygonRing(sector.points),
        color: sector.color + '16',
        strokeColor: sector.color,
        strokeWidth: 4,
        interactive: false,
        zIndex: 20
      }));

      sectorLabels.push(new mapgl.HtmlMarker(map, {
        coordinates: sectorCenter(sector.points),
        html: `<div class="sector-label" style="color:${sector.color}">${sector.name}</div>`,
        interactive: false,
        preventMapInteractions: false,
        maxZoom: 14,
        zIndex: 21
      }));
    });
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
  function pointOnSegment(p, a, b, eps = 1e-9) {
    const cross = (p[1] - a[1]) * (b[0] - a[0]) - (p[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(cross) > eps) return false;
    const dot = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]);
    if (dot < -eps) return false;
    const lenSq = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    return dot <= lenSq + eps;
  }

  function pointInPolygon(point, polygon) {
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      if (pointOnSegment(point, polygon[j], polygon[i], 1e-8)) return true;
    }

    const x = point[0], y = point[1];
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][0], yi = polygon[i][1];
      const xj = polygon[j][0], yj = polygon[j][1];
      const intersects =
        ((yi > y) !== (yj > y)) &&
        (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function findSector(coords) {
    return sectors.find((sector) => pointInPolygon(coords, sector.points)) || null;
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

  function showInfo({ coords, title, address, type, id }) {
    const sector = findSector(coords);
    const badge = $('sectorBadge');
    const sectorText = sector ? `Сектор ${sector.name}` : 'Вне секторов';

    badge.textContent = sectorText;
    badge.style.background = sector?.color || '#333';

    $('objectType').textContent = typeLabel(type);
    $('sheetTitle').textContent = title || 'Точка на карте';
    $('sheetAddress').textContent = address || 'Без адреса';
    $('sheetSector').textContent = sectorText;
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
    if (!e.target.closest('.search-shell')) {
      $('searchResults').classList.add('hidden');
    }
  });

  $('homeBtn').addEventListener('click', () => {
    map.setCenter(CITY_CENTER);
    map.setZoom(CITY_ZOOM);
    hideInfo();
  });

  $('toggleSectorsBtn').addEventListener('click', () => {
    sectorsVisible = !sectorsVisible;
    $('toggleSectorsBtn').classList.toggle('active', sectorsVisible);
    $('legend').classList.toggle('hidden', !sectorsVisible);
    renderSectors();
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
    if (!navigator.geolocation) {
      showToast('Геолокация не поддерживается этим браузером');
      return;
    }

    $('locateBtn').disabled = true;
    showToast('Определяю местоположение…', 5000);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        $('locateBtn').disabled = false;
        const coords = [pos.coords.longitude, pos.coords.latitude];
        setMarker(coords);
        map.setCenter(coords);
        map.setZoom(16);
        showInfo({
          coords,
          title: 'Моё местоположение',
          address: `Точность ≈ ${Math.round(pos.coords.accuracy)} м`,
          type: ''
        });
        showToast(findSector(coords) ? 'Сектор определён' : 'Вы находитесь вне заданных секторов');
      },
      (err) => {
        $('locateBtn').disabled = false;
        const messages = {
          1: 'Доступ к геопозиции запрещён',
          2: 'Не удалось определить геопозицию',
          3: 'Истекло время определения геопозиции',
        };
        showToast(messages[err.code] || 'Ошибка геолокации');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 }
    );
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

    // Immediately show sector, then enrich card with 2GIS object details.
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
        address: 'Сектор определён по точке нажатия',
        type: event.targetData?.type,
        id: targetId
      });
    }
  });

  // Only refresh after MapGL is fully idle. No Places/Markers requests occur
  // continuously during drag, pinch, rotation or pitch.
  map.on('idle', () => schedulePoiRefresh(450));

  renderLegend();
  renderSectors();
  schedulePoiRefresh(900);

  // PWA: safe enhancement; app still works without service worker.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
