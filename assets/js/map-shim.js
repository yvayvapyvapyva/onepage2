/* Совместимость с ymaps3 поверх MapLibre GL.
 *
 * navigator.html и editor.html написаны под небольшой набор API Яндекс.Карт v3:
 * YMap, YMapMarker, YMapFeature, YMapListener и слои схемы/спутника.
 * Здесь те же классы, но отрисовка идёт через MapLibre со стилями из
 * map-styles.js — теми же слоями, что в navigator3.
 */
(function (global) {
    'use strict';

    if (!global.maplibregl) {
        console.error('[map-shim] maplibregl не загружен');
        return;
    }

    const maplibregl = global.maplibregl;

    /* ------------------------------------------------------------------
     * Яндекс.Спутник: пересчёт проекции EPSG:3395 -> Web Mercator.
     * Тайлы Яндекса отдаются в эллипсоидном Меркаторе, а MapLibre рисует
     * сферический Web Mercator: по долготе совпадает, по широте нужен сдвиг.
     * ------------------------------------------------------------------ */
    const YANDEX_MERC_E = 0.0818191908426;

    function webRowToLat(R, worldPx) {
        return Math.atan(Math.sinh(Math.PI * (1 - 2 * R / worldPx))) * 180 / Math.PI;
    }

    function latToYandexRow(lat, worldPx) {
        const b = lat * Math.PI / 180;
        const phi = (1 - YANDEX_MERC_E * Math.sin(b)) / (1 + YANDEX_MERC_E * Math.sin(b));
        const theta = Math.tan(Math.PI / 4 + b / 2) * Math.pow(phi, YANDEX_MERC_E / 2);
        return worldPx * (1 - Math.log(theta) / Math.PI) / 2;
    }

    function makeCanvas(w, h) {
        if (typeof OffscreenCanvas !== 'undefined') {
            const c = new OffscreenCanvas(w, h);
            return { canvas: c, ctx: c.getContext('2d'), offscreen: true };
        }
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return { canvas: c, ctx: c.getContext('2d'), offscreen: false };
    }

    async function fetchTileBitmap(url, signal) {
        const res = await fetch(url, { signal, mode: 'cors' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await createImageBitmap(await res.blob());
    }

    async function buildYandexTile(params, abortController) {
        const m = /yandexsat:\/\/sat\/(\d+)\/(\d+)\/(\d+)/.exec((params && params.url) || '');
        if (!m) throw new Error('Некорректный URL тайла Яндекса');
        const z = +m[1], x = +m[2], y = +m[3];
        const n = Math.pow(2, z);
        const worldPx = 256 * n;

        const lat = webRowToLat(256 * y, worldPx);
        const yRow = latToYandexRow(lat, worldPx);
        let srcY = Math.floor(yRow / 256);
        srcY = Math.max(0, Math.min(n - 1, srcY));
        const shiftUp = Math.max(0, Math.min(255.999, yRow - 256 * srcY));
        const snap = Math.max(0, Math.min(255, Math.round(shiftUp)));

        const base = 'https://core-sat.maps.yandex.net/tiles?l=sat&x=' + x + '&y=';
        const signal = abortController && abortController.signal;
        const secondY = Math.min(n - 1, srcY + 1);
        const [imgA, imgB] = await Promise.all([
            fetchTileBitmap(base + srcY + '&z=' + z, signal),
            snap > 0
                ? fetchTileBitmap(base + secondY + '&z=' + z, signal).catch(() => null)
                : Promise.resolve(null)
        ]);

        const { canvas, ctx, offscreen } = makeCanvas(256, 256);
        ctx.drawImage(imgA, 0, -snap);
        if (imgB) ctx.drawImage(imgB, 0, 256 - snap);
        if (imgA.close) imgA.close();
        if (imgB && imgB.close) imgB.close();

        const data = offscreen ? canvas.transferToImageBitmap() : await createImageBitmap(canvas);
        return { data };
    }

    let protocolsRegistered = false;
    function registerProtocols() {
        if (protocolsRegistered) return;
        if (maplibregl.addProtocol) {
            maplibregl.addProtocol('yandexsat', buildYandexTile);
            if (global.pmtiles && global.pmtiles.Protocol) {
                try {
                    maplibregl.addProtocol('pmtiles', new global.pmtiles.Protocol().tile);
                } catch (e) {
                    console.warn('[map-shim] pmtiles protocol:', e);
                }
            }
        }
        protocolsRegistered = true;
    }

    registerProtocols();

    function styleDefinition(type) {
        if (typeof global.mapStyleDefinition === 'function') {
            return global.mapStyleDefinition(type);
        }
        return {
            version: 8,
            sources: {
                osm: {
                    type: 'raster',
                    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
                    tileSize: 256
                }
            },
            layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
        };
    }

    function mapOf() {
        return global.__osmMap || null;
    }

    /* ------------------------------------------------------------------
     * Маркер: DOM-элемент, привязанный к координатам.
     * ------------------------------------------------------------------ */
    class YMapMarker {
        constructor(opts, element) {
            opts = opts || {};
            this.element = element;
            this._opts = opts;
            this._lngLat = opts.coordinates ? opts.coordinates.slice() : null;
            this._attachedMap = null;
            this._onMap = false;
            this._marker = new maplibregl.Marker({
                element: element,
                anchor: 'center',
                draggable: !!opts.draggable
            });
            if (this._lngLat) this._marker.setLngLat(this._lngLat);
            if (opts.draggable && typeof opts.onDragMove === 'function') {
                this._marker.on('drag', () => {
                    const pos = this._marker.getLngLat();
                    try {
                        opts.onDragMove([pos.lng, pos.lat]);
                    } catch (e) {
                        console.warn('[map-shim] onDragMove:', e);
                    }
                });
            }
        }

        update(params) {
            if (params && params.coordinates) {
                this._lngLat = params.coordinates.slice();
                this._marker.setLngLat(this._lngLat);
            }
        }

        _attach(map) {
            if (this._attachedMap === map) return;
            if (this._lngLat) this._marker.setLngLat(this._lngLat);
            this._marker.addTo(map);
            this._attachedMap = map;
            this._onMap = true;
        }

        _detach() {
            try { this._marker.remove(); } catch (e) {}
            this._attachedMap = null;
            this._onMap = false;
        }
    }

    /* ------------------------------------------------------------------
     * Линия: GeoJSON-источник + слои под каждый штрих.
     * Порядок штрихов в ymaps3 — сверху вниз, поэтому слои добавляем
     * в обратном порядке: первый штрих рисуется последним и остаётся сверху.
     * ------------------------------------------------------------------ */
    let featureSeq = 0;

    class YMapFeature {
        constructor(opts) {
            opts = opts || {};
            this._geometry = opts.geometry || null;
            this._style = opts.style || {};
            this._z = typeof this._style.zIndex === 'number' ? this._style.zIndex : 0;
            this._id = 'ymf' + (++featureSeq);
            this._layers = [];
            this._map = null;
            this._onMap = false;
        }

        update(params) {
            params = params || {};
            if (params.geometry) this._geometry = params.geometry;
            if (params.style) {
                this._style = params.style;
                if (typeof params.style.zIndex === 'number') this._z = params.style.zIndex;
            }
            if (this._map) this._sync();
        }

        _strokes() {
            const stroke = this._style.stroke;
            if (Array.isArray(stroke)) return stroke;
            if (stroke) return [stroke];
            return [];
        }

        _attach(map) {
            if (this._map === map) return;
            this._map = map;
            this._build();
            const ymap = map.__ymap;
            if (ymap) ymap._reorder();
        }

        _detach() {
            if (this._map) this._removeLayers();
            this._map = null;
            this._onMap = false;
        }

        _ensure(map) {
            if (!map) return;
            if (!map.getSource(this._id)) this._build();
        }

        _build() {
            const map = this._map;
            if (!map) return;
            try {
                this._removeLayers();
                if (!this._geometry) return;
                this._removeSource();
                map.addSource(this._id, {
                    type: 'geojson',
                    data: { type: 'Feature', properties: {}, geometry: this._geometry }
                });
                const strokes = this._strokes().slice().reverse();
                strokes.forEach((stroke, i) => {
                    const layerId = this._id + '-' + i;
                    map.addLayer({
                        id: layerId,
                        type: 'line',
                        source: this._id,
                        layout: { 'line-cap': 'round', 'line-join': 'round' },
                        paint: {
                            'line-color': stroke.color || '#000000',
                            'line-width': stroke.width == null ? 2 : stroke.width,
                            'line-opacity': stroke.opacity == null ? 1 : stroke.opacity
                        }
                    });
                    this._layers.push(layerId);
                });
            } catch (e) {
                console.warn('[map-shim] feature build:', e);
            }
        }

        _sync() {
            const map = this._map;
            if (!map || !this._geometry) return;
            try {
                const source = map.getSource(this._id);
                if (!source) {
                    this._build();
                    return;
                }
                source.setData({ type: 'Feature', properties: {}, geometry: this._geometry });
                const strokes = this._strokes();
                if (strokes.length !== this._layers.length) {
                    this._build();
                    return;
                }
                const reversed = strokes.slice().reverse();
                reversed.forEach((stroke, i) => {
                    const layerId = this._layers[i];
                    if (!map.getLayer(layerId)) return;
                    map.setPaintProperty(layerId, 'line-color', stroke.color || '#000000');
                    map.setPaintProperty(layerId, 'line-width', stroke.width == null ? 2 : stroke.width);
                    map.setPaintProperty(layerId, 'line-opacity', stroke.opacity == null ? 1 : stroke.opacity);
                });
            } catch (e) {
                console.warn('[map-shim] feature sync:', e);
            }
        }

        _removeLayers() {
            const map = this._map;
            if (!map) return;
            this._layers.forEach((id) => {
                try {
                    if (map.getLayer(id)) map.removeLayer(id);
                } catch (e) {}
            });
            this._layers = [];
        }

        _removeSource() {
            const map = this._map;
            if (!map) return;
            try {
                if (map.getSource(this._id)) map.removeSource(this._id);
            } catch (e) {}
        }
    }

    /* ------------------------------------------------------------------
     * Слушатель карты.
     * ------------------------------------------------------------------ */
    class YMapListener {
        constructor(opts) {
            this._opts = opts || {};
            this._map = null;
            this._handler = null;
        }

        _attach(map) {
            this._map = map;
            this._handler = (e) => {
                const object = this._hitTest(e.point);
                const event = {
                    coordinates: [e.lngLat.lng, e.lngLat.lat],
                    screenCoordinates: [e.point.x, e.point.y],
                    originalEvent: e.originalEvent || null
                };
                if (typeof this._opts.onFastClick === 'function') {
                    this._opts.onFastClick(object, event);
                }
                if (typeof this._opts.onClick === 'function') {
                    this._opts.onClick(object, event);
                }
            };
            map.on('click', this._handler);
        }

        _hitTest(point) {
            const map = this._map;
            const ymap = map && map.__ymap;
            if (!map || !ymap) return null;
            const layers = [];
            ymap._features.forEach((feature) => {
                feature._layers.forEach((id) => layers.push(id));
            });
            if (!layers.length) return null;
            let rendered;
            try {
                rendered = map.queryRenderedFeatures(point, { layers });
            } catch (e) {
                return null;
            }
            if (!rendered.length) return null;
            const layerId = rendered[0].layer.id;
            const owner = ymap._features.find((f) => f._layers.indexOf(layerId) !== -1);
            return owner ? { type: 'feature', entity: owner } : null;
        }

        _detach() {
            if (this._map && this._handler) this._map.off('click', this._handler);
            this._map = null;
            this._handler = null;
        }
    }

    /* ------------------------------------------------------------------
     * Заглушки слоёв: схема и спутник переключают стиль MapLibre.
     * ------------------------------------------------------------------ */
    function applyStyle(map, type) {
        if (!map || map.__ymStyleKey === type) return;
        map.__ymStyleKey = type;
        try {
            map.setStyle(styleDefinition(type));
        } catch (e) {
            console.warn('[map-shim] setStyle:', e);
        }
    }

    class YMapDefaultSchemeLayer {
        _attach(map) { applyStyle(map, 'nn_3d'); }
        _detach() {}
    }

    class YMapDefaultSatelliteLayer {
        _attach(map) { applyStyle(map, 'yandex_sat'); }
        _detach() {}
    }

    class YMapDefaultFeaturesLayer {
        _attach() {}
        _detach() {}
    }

    class YMapBuildings {
        _attach() {}
        _detach() {}
    }

    class YMapControls {
        constructor() {}
        _attach() {}
        _detach() {}
    }

    /* ------------------------------------------------------------------
     * Карта.
     * ------------------------------------------------------------------ */
    class YMap {
        constructor(container, opts) {
            opts = opts || {};
            const location = opts.location || {};
            const zoomRange = opts.zoomRange || {};
            this._children = new Set();
            this._features = [];
            this._reordering = false;

            const map = new maplibregl.Map({
                container: container,
                style: styleDefinition('yandex_sat'),
                center: location.center || [37.6173, 55.7558],
                zoom: location.zoom == null ? 10 : location.zoom,
                minZoom: zoomRange.min == null ? 2 : zoomRange.min,
                maxZoom: zoomRange.max == null ? 22 : zoomRange.max,
                attributionControl: { compact: true },
                dragRotate: true,
                pitchWithRotate: true,
                touchPitch: true
            });
            map.__ymStyleKey = 'yandex_sat';
            map.__ymap = this;
            this._map = map;
            global.__osmMap = map;

            const restore = () => this._restoreFeatures();
            map.on('styledata', restore);
            map.on('idle', restore);
            map.once('load', restore);
        }

        get map() { return this._map; }

        get zoom() {
            return this._map ? this._map.getZoom() : 0;
        }

        /* ymaps3: azimuth в радианах, положительное — против часовой стрелки.
           MapLibre: bearing в градусах по часовой стрелке. */
        get azimuth() {
            return this._map ? -this._map.getBearing() * Math.PI / 180 : 0;
        }

        get center() {
            if (!this._map) return [0, 0];
            const c = this._map.getCenter();
            return [c.lng, c.lat];
        }

        addChild(child) {
            if (!child || typeof child._attach !== 'function') return;
            if (child instanceof YMapFeature) {
                if (this._features.indexOf(child) === -1) this._features.push(child);
            }
            child._attach(this._map, this);
            this._children.add(child);
            if (child instanceof YMapFeature) this._reorder();
        }

        removeChild(child) {
            if (!child || typeof child._detach !== 'function') return;
            child._detach(this._map, this);
            this._children.delete(child);
            if (child instanceof YMapFeature) {
                this._features = this._features.filter((f) => f !== child);
            }
        }

        update(params) {
            const map = this._map;
            if (!map || !params) return;
            const location = params.location || {};
            const camera = params.camera || {};
            const duration = location.duration != null
                ? location.duration
                : (camera.duration != null ? camera.duration : 0);

            if (location.bounds && location.bounds.length === 2) {
                const bounds = location.bounds;
                try {
                    map.fitBounds(
                        [[bounds[0][0], bounds[0][1]], [bounds[1][0], bounds[1][1]]],
                        { duration: duration, padding: 40, maxZoom: 18 }
                    );
                } catch (e) {
                    console.warn('[map-shim] fitBounds:', e);
                }
                return;
            }

            const options = {};
            if (location.center) options.center = location.center;
            if (location.zoom != null) options.zoom = location.zoom;
            if (camera.tilt != null) options.pitch = camera.tilt;
            if (camera.azimuth != null) options.bearing = -camera.azimuth * 180 / Math.PI;
            if (!Object.keys(options).length) return;
            try {
                if (duration > 0) map.easeTo(Object.assign({ duration: duration }, options));
                else map.jumpTo(options);
            } catch (e) {
                console.warn('[map-shim] update:', e);
            }
        }

        _restoreFeatures() {
            const map = this._map;
            if (!map) return;
            this._features.forEach((feature) => feature._ensure(map));
            this._reorder();
        }

        _reorder() {
            const map = this._map;
            if (!map || this._reordering) return;
            this._reordering = true;
            try {
                const desired = [];
                this._features
                    .slice()
                    .sort((a, b) => (a._z || 0) - (b._z || 0))
                    .forEach((feature) => {
                        feature._layers.forEach((id) => {
                            if (map.getLayer(id)) desired.push(id);
                        });
                    });
                if (!desired.length) return;
                const style = map.getStyle();
                const current = (style.layers || [])
                    .map((layer) => layer.id)
                    .filter((id) => desired.indexOf(id) !== -1);
                if (current.join('|') === desired.join('|')) return;
                desired.forEach((id) => {
                    if (map.getLayer(id)) map.moveLayer(id);
                });
            } finally {
                this._reordering = false;
            }
        }
    }

    /* ------------------------------------------------------------------
     * Глобальный объект с тем же именем, что у Яндекс.Карт.
     * ------------------------------------------------------------------ */
    const ymaps3 = {
        ready: Promise.resolve(),
        YMap: YMap,
        YMapMarker: YMapMarker,
        YMapFeature: YMapFeature,
        YMapListener: YMapListener,
        YMapDefaultSchemeLayer: YMapDefaultSchemeLayer,
        YMapDefaultSatelliteLayer: YMapDefaultSatelliteLayer,
        YMapDefaultFeaturesLayer: YMapDefaultFeaturesLayer,
        YMapBuildings: YMapBuildings,
        YMapControls: YMapControls
    };

    ymaps3.import = function () {
        return Promise.resolve({ YMapBuildings: YMapBuildings });
    };
    ymaps3.import.registerCdn = function () {};

    global.ymaps3 = ymaps3;
})(window);
