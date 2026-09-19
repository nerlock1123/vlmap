
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

    // Native MapGL gestures:
    // 1 finger = pan
    // pinch = zoom
    // 2 fingers = rotate / pitch
    disableRotationByUserInteraction: false,
    disablePitchByUserInteraction: false,

    // Let MapGL choose the appropriate rendering complexity for the device.
    graphicsPreset: 'auto'
  });

  let sectorObjects = [];
  let sectorLabels = [];
  let sectorsVisible = true;
  let selectionMarker = null;
  let searchAbort = null;
  let searchTimer = null;
  let toastTimer = null;

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

  renderLegend();
  renderSectors();

  // PWA: safe enhancement; app still works without service worker.
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
