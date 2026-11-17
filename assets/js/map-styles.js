const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>';
const MAP_STYLES = {
    nn_3d: {
        label: 'Нижегородская обл. 3D',
        vector: true,
        omt: true,
        attribution: OSM_ATTRIBUTION,
        pmtiles: 'https://storage.yandexcloud.net/nn-map-tiles/nn-omt.pmtiles',
        glyphs: 'https://storage.yandexcloud.net/nn-map-tiles/fonts/{fontstack}/{range}.pbf',
        font: 'NotoSansRegular',
        fontBold: 'NotoSansBold'
    },
    versa_3d: {
        label: 'Россия 3D (VersaTiles)',
        vector: true,
        schema: 'shortbread',
        buildings3d: true,
        pitch3d: true,
        tiles: ['https://tiles.versatiles.org/tiles/osm/{z}/{x}/{y}'],
        attribution: OSM_ATTRIBUTION + ' · <a href="https://versatiles.org" target="_blank" rel="noopener">VersaTiles</a>',
        glyphs: 'https://storage.yandexcloud.net/nn-map-tiles/fonts/{fontstack}/{range}.pbf',
        font: 'NotoSansRegular',
        fontBold: 'NotoSansBold'
    },
    yandex_sat: {
        label: 'Яндекс.Спутник',
        tiles: ['yandexsat://sat/{z}/{x}/{y}']
    }
};

function omtStyleDefinition(style) {
    const font = style.font || 'NotoSansRegular';
    const fontBold = style.fontBold || 'NotoSansBold';
    const S = 'omt';

    return {
        version: 8,
        glyphs: style.glyphs,
        sources: {
            [S]: {
                type: 'vector',
                url: 'pmtiles://' + style.pmtiles,
                minzoom: 0,
                maxzoom: 14,
                attribution: style.attribution || OSM_ATTRIBUTION
            }
        },
        layers: [
            { id: 'omt-bg', type: 'background', paint: { 'background-color': '#f7f4ef' } },

            { id: 'omt-landcover', type: 'fill', source: S, 'source-layer': 'landcover',
              paint: { 'fill-color': ['match', ['get', 'class'],
                ['wood', 'forest'], '#cfe0c3',
                ['grass', 'meadow'], '#d8e8c8',
                ['farmland'], '#eef0d8',
                ['sand', 'beach'], '#f4ecd3',
                ['wetland'], '#d4e7dc',
                ['ice', 'glacier'], '#eef4f7',
                'rgba(0,0,0,0)'], 'fill-opacity': 0.8 } },

            { id: 'omt-landuse', type: 'fill', source: S, 'source-layer': 'landuse',
              paint: { 'fill-color': ['match', ['get', 'class'],
                ['residential', 'suburb', 'neighbourhood'], '#ebe6df',
                ['commercial', 'retail'], '#efe2e8',
                ['industrial', 'railway', 'quarry'], '#e6e2dd',
                ['cemetery'], '#dfe7da',
                ['park', 'garden', 'playground', 'pitch'], '#d8e8c8',
                'rgba(0,0,0,0)'], 'fill-opacity': 0.7 } },

            { id: 'omt-water', type: 'fill', source: S, 'source-layer': 'water',
              paint: { 'fill-color': '#a6cfe1' } },

            { id: 'omt-waterway', type: 'line', source: S, 'source-layer': 'waterway',
              minzoom: 9,
              paint: { 'line-color': '#a6cfe1',
                'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 14, 3] } },

            { id: 'omt-boundary', type: 'line', source: S, 'source-layer': 'boundary',
              filter: ['<=', ['to-number', ['get', 'admin_level'], 99], 6],
              paint: { 'line-color': '#9c8fb0',
                'line-width': ['case', ['<=', ['to-number', ['get', 'admin_level'], 99], 4], 1.5, 0.8],
                'line-dasharray': [3, 2] } },

            ...LIBERTY_ROADS,

            { id: 'omt-building', type: 'fill', source: S, 'source-layer': 'building',
              minzoom: 14,
              paint: { 'fill-color': '#dcd5cc',
                'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 1] } },

            { id: 'omt-building-3d', type: 'fill-extrusion', source: S, 'source-layer': 'building',
              minzoom: 14.5,
              filter: ['!=', ['get', 'hide_3d'], true],
              paint: {
                'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 4],
                  0, '#e3ddd5', 20, '#d7cfc5', 60, '#c8bdb1', 150, '#b3a89b'],
                'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 4],
                'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
                'fill-extrusion-opacity': 0.92,
                'fill-extrusion-vertical-gradient': true
              } },

            { id: 'omt-place', type: 'symbol', source: S, 'source-layer': 'place',
              minzoom: 4,
              filter: ['match', ['get', 'class'], ['city', 'town', 'village', 'suburb', 'neighbourhood'], true, false],
              layout: {
                'text-field': ['coalesce', ['get', 'name:ru'], ['get', 'name']],
                'text-font': [fontBold],
                'text-size': ['interpolate', ['linear'], ['zoom'], 5, 10, 9, 13, 14, 16],
                'text-anchor': 'top', 'text-offset': [0, 0.4]
              },
              paint: { 'text-color': '#232c35', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } },

            { id: 'omt-water-name', type: 'symbol', source: S, 'source-layer': 'water_name',
              minzoom: 12,
              layout: { 'text-field': ['coalesce', ['get', 'name:ru'], ['get', 'name']],
                'text-font': [font], 'text-size': 11, 'symbol-placement': 'line' },
              paint: { 'text-color': '#3f8aab', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 } },

            { id: 'omt-road-name', type: 'symbol', source: S, 'source-layer': 'transportation_name',
              minzoom: 12,
              layout: { 'text-field': ['coalesce', ['get', 'name:ru'], ['get', 'name']],
                'text-font': [font],
                'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 14, 12.5, 18, 15],
                'symbol-placement': 'line',
                'text-rotation-alignment': 'map',
                'text-padding': 2 },
              paint: { 'text-color': '#666666', 'text-halo-color': '#ffffff',
                'text-halo-width': 1, 'text-halo-blur': 0.5 } },

            { id: 'omt-housenumber', type: 'symbol', source: S, 'source-layer': 'housenumber',
              minzoom: 16,
              layout: { 'text-field': ['get', 'housenumber'], 'text-font': [font], 'text-size': 9 },
              paint: { 'text-color': '#6b7480', 'text-halo-color': '#ffffff', 'text-halo-width': 1 } },

            { id: 'omt-poi', type: 'symbol', source: S, 'source-layer': 'poi',
              minzoom: 16,
              filter: ['has', 'name'],
              layout: { 'text-field': ['coalesce', ['get', 'name:ru'], ['get', 'name']],
                'text-font': [font], 'text-size': 10, 'text-anchor': 'top', 'text-offset': [0, 0.3] },
              paint: { 'text-color': '#5a6068', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 } }
        ]
    };
}

// «Вся Россия 3D» на данных VersaTiles (схема Shortbread, у зданий есть height/min_height).
// Дорожная сетка повторяет вид Liberty, но на свойствах Shortbread (kind/link/bridge/tunnel).
function versaStyleDefinition(style) {
    const font = style.font || 'NotoSansRegular';
    const fontBold = style.fontBold || 'NotoSansBold';
    const S = 'versa';
    const KIND = ['get', 'kind'];

    const MOTORWAY = ['motorway', 'motorway_link'];
    const TRUNK_PRIMARY = ['trunk', 'trunk_link', 'primary', 'primary_link'];
    const SECONDARY_TERTIARY = ['secondary', 'secondary_link', 'tertiary', 'tertiary_link'];
    const MINOR = ['unclassified', 'residential', 'living_street', 'busway', 'bus_guideway'];
    const SERVICE = ['service', 'track'];
    const PATH = ['footway', 'path', 'steps', 'cycleway', 'pedestrian'];
    const RAIL = ['rail', 'narrow_gauge', 'tram', 'light_rail', 'funicular', 'subway', 'monorail'];
    const AIR = ['runway', 'taxiway'];
    const MAJOR = MOTORWAY.concat(TRUNK_PRIMARY, SECONDARY_TERTIARY);

    const kindIn = (list) => ['match', KIND, list, true, false];
    const onGround = (list) => ['all', kindIn(list), ['!=', ['get', 'tunnel'], true]];

    const W_MOTORWAY_C = ['interpolate', ['exponential', 1.2], ['zoom'], 5, 0.4, 6, 0.7, 7, 1.75, 20, 22];
    const W_TRUNK_C = ['interpolate', ['exponential', 1.2], ['zoom'], 5, 0.4, 6, 0.7, 7, 1.75, 20, 22];
    const W_SECONDARY_C = ['interpolate', ['exponential', 1.2], ['zoom'], 8, 1.5, 20, 17];
    const W_MINOR_C = ['interpolate', ['exponential', 1.2], ['zoom'], 12, 0.5, 13, 1, 14, 4, 20, 20];
    const W_SERVICE_C = ['interpolate', ['exponential', 1.2], ['zoom'], 15, 1, 16, 4, 20, 11];
    const W_MOTORWAY = ['interpolate', ['exponential', 1.2], ['zoom'], 5, 0, 7, 1, 20, 18];
    const W_TRUNK = ['interpolate', ['exponential', 1.2], ['zoom'], 5, 0, 7, 1, 20, 18];
    const W_SECONDARY = ['interpolate', ['exponential', 1.2], ['zoom'], 6.5, 0, 8, 0.5, 20, 13];
    const W_MINOR = ['interpolate', ['exponential', 1.2], ['zoom'], 13.5, 0, 14, 2.5, 20, 18];
    const W_SERVICE = ['interpolate', ['exponential', 1.2], ['zoom'], 15.5, 0, 16, 2, 20, 7.5];
    const W_PATH = ['interpolate', ['exponential', 1.2], ['zoom'], 14, 1, 20, 10];
    const W_RAIL = ['interpolate', ['exponential', 1.4], ['zoom'], 14, 0.4, 15, 0.75, 20, 2];

    const road = (id, filter, paint, extra) => Object.assign({
        id: id, type: 'line', source: S, 'source-layer': 'streets',
        filter: filter,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: paint
    }, extra || {});

    const layers = [
        { id: 'versa-bg', type: 'background', paint: { 'background-color': '#f7f4ef' } },

        { id: 'versa-land', type: 'fill', source: S, 'source-layer': 'land',
          paint: { 'fill-color': ['match', KIND,
            ['forest'], '#cfe0c3',
            ['grass', 'meadow', 'village_green', 'recreation_ground'], '#d8e8c8',
            ['orchard', 'vineyard', 'allotments', 'plant_nursery', 'greenhouse_horticulture'], '#e2ecd2',
            ['cemetery', 'grave_yard'], '#dfe7da',
            ['sand', 'beach'], '#f4ecd3',
            ['heath', 'scrub'], '#dbe7cc',
            'rgba(0,0,0,0)'], 'fill-opacity': 0.85 } },

        { id: 'versa-sites', type: 'fill', source: S, 'source-layer': 'sites',
          paint: { 'fill-color': ['match', KIND,
            ['parking', 'bicycle_parking', 'construction'], '#e6e2dd',
            ['school', 'university', 'college'], '#eee7dd',
            ['hospital'], '#f0e3e3',
            ['danger_area'], 'rgba(0,0,0,0)',
            '#e9e5df'], 'fill-opacity': 0.7 } },

        { id: 'versa-water', type: 'fill', source: S, 'source-layer': 'water_polygons',
          paint: { 'fill-color': '#a6cfe1' } },

        { id: 'versa-waterway', type: 'line', source: S, 'source-layer': 'water_lines',
          minzoom: 9,
          paint: { 'line-color': '#a6cfe1',
            'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.5, 14, 3] } },

        { id: 'versa-pedestrian-areas', type: 'fill', source: S, 'source-layer': 'street_polygons',
          minzoom: 13,
          paint: { 'fill-color': '#ffffff' } },

        road('versa-tunnel-casing-major', ['all', kindIn(MAJOR), ['==', ['get', 'tunnel'], true]],
            { 'line-color': '#e9ac77', 'line-dasharray': [0.5, 0.25], 'line-width': W_SECONDARY_C }),
        road('versa-tunnel-casing-minor', ['all', kindIn(SERVICE.concat(MINOR)), ['==', ['get', 'tunnel'], true]],
            { 'line-color': '#cfcdca', 'line-dasharray': [0.5, 0.25], 'line-width': W_MINOR_C }),

        road('versa-casing-motorway', onGround(MOTORWAY),
            { 'line-color': '#e9ac77', 'line-width': W_MOTORWAY_C }, { minzoom: 5 }),
        road('versa-casing-trunk-primary', onGround(TRUNK_PRIMARY),
            { 'line-color': '#e9ac77', 'line-width': W_TRUNK_C }),
        road('versa-casing-secondary-tertiary', onGround(SECONDARY_TERTIARY),
            { 'line-color': '#e9ac77', 'line-width': W_SECONDARY_C }),
        road('versa-casing-minor', onGround(MINOR),
            { 'line-color': '#cfcdca', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0, 12.5, 1],
              'line-width': W_MINOR_C }),
        road('versa-casing-service', onGround(SERVICE),
            { 'line-color': '#cfcdca', 'line-width': W_SERVICE_C }),

        road('versa-road-motorway', kindIn(MOTORWAY),
            { 'line-color': ['interpolate', ['linear'], ['zoom'], 5, 'hsl(26,87%,62%)', 6, '#fc8'],
              'line-width': W_MOTORWAY }, { minzoom: 5 }),
        road('versa-road-trunk-primary', kindIn(TRUNK_PRIMARY),
            { 'line-color': '#fea', 'line-width': W_TRUNK }),
        road('versa-road-secondary-tertiary', kindIn(SECONDARY_TERTIARY),
            { 'line-color': '#fea', 'line-width': W_SECONDARY }),
        road('versa-road-minor', kindIn(MINOR),
            { 'line-color': '#ffffff', 'line-width': W_MINOR }),
        road('versa-road-service', kindIn(SERVICE),
            { 'line-color': '#ffffff', 'line-width': W_SERVICE }),
        road('versa-road-path', kindIn(PATH),
            { 'line-color': '#efeae1', 'line-dasharray': [1, 0.7], 'line-width': W_PATH }, { minzoom: 14 }),
        road('versa-road-air', kindIn(AIR),
            { 'line-color': '#d8d3cb', 'line-width': W_SECONDARY_C }),

        road('versa-rail', kindIn(RAIL),
            { 'line-color': '#bbb', 'line-width': W_RAIL }),
        road('versa-rail-hatching', kindIn(RAIL),
            { 'line-color': '#bbb', 'line-dasharray': [0.2, 8],
              'line-width': ['interpolate', ['exponential', 1.4], ['zoom'], 14.5, 0, 15, 3, 20, 8] }, { minzoom: 14.5 }),

        { id: 'versa-building', type: 'fill', source: S, 'source-layer': 'buildings',
          minzoom: 14,
          paint: { 'fill-color': '#dcd5cc',
            'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, 1] } }
    ];

    if (style.buildings3d) {
        layers.push({
            id: 'versa-building-3d', type: 'fill-extrusion', source: S, 'source-layer': 'buildings',
            minzoom: 14.5,
            paint: {
                'fill-extrusion-color': ['interpolate', ['linear'],
                    ['max', 3, ['to-number', ['get', 'height'], 4]],
                    0, '#e3ddd5', 20, '#d7cfc5', 60, '#c8bdb1', 150, '#b3a89b'],
                'fill-extrusion-height': ['max', 3, ['to-number', ['get', 'height'], 4]],
                'fill-extrusion-base': ['max', 0, ['to-number', ['get', 'min_height'], 0]],
                'fill-extrusion-opacity': 0.92,
                'fill-extrusion-vertical-gradient': true
            }
        });
    }

    layers.push(
        { id: 'versa-place-label', type: 'symbol', source: S, 'source-layer': 'place_labels',
          minzoom: 6,
          filter: ['match', KIND,
            ['capital', 'state_capital', 'city', 'town', 'village', 'hamlet', 'suburb', 'quarter', 'neighbourhood'], true, false],
          layout: {
            'text-field': ['coalesce', ['get', 'name'], ['get', 'name_en']],
            'text-font': [fontBold],
            'text-size': ['interpolate', ['linear'], ['zoom'],
                6, ['match', KIND, ['capital', 'state_capital', 'city'], 12, 'town', 10, 10],
                12, ['match', KIND, ['capital', 'state_capital', 'city'], 15, 'town', 12.5, 11.5],
                16, ['match', KIND, ['capital', 'state_capital', 'city'], 17, 'town', 14, 12.5]],
            'text-anchor': 'top',
            'text-offset': [0, 0.4]
          },
          paint: { 'text-color': '#232c35', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } },

        { id: 'versa-water-label', type: 'symbol', source: S, 'source-layer': 'water_polygons_labels',
          minzoom: 12,
          layout: { 'text-field': ['coalesce', ['get', 'name'], ['get', 'name_en']],
            'text-font': [font], 'text-size': 11 },
          paint: { 'text-color': '#3f8aab', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 } },

        { id: 'versa-road-label', type: 'symbol', source: S, 'source-layer': 'street_labels',
          minzoom: 12,
          layout: { 'text-field': ['coalesce', ['get', 'name'], ['get', 'ref']],
            'text-font': [font],
            'text-size': ['interpolate', ['linear'], ['zoom'], 12, 10, 14, 12.5, 18, 15],
            'symbol-placement': 'line',
            'text-rotation-alignment': 'map',
            'text-padding': 2 },
          paint: { 'text-color': '#666666', 'text-halo-color': '#ffffff',
            'text-halo-width': 1, 'text-halo-blur': 0.5 } },

        { id: 'versa-poi', type: 'symbol', source: S, 'source-layer': 'pois',
          minzoom: 16,
          filter: ['has', 'name'],
          layout: { 'text-field': ['get', 'name'],
            'text-font': [font], 'text-size': 10, 'text-anchor': 'top', 'text-offset': [0, 0.3] },
          paint: { 'text-color': '#5a6068', 'text-halo-color': '#ffffff', 'text-halo-width': 1.2 } }
    );

    return {
        version: 8,
        glyphs: style.glyphs,
        sources: {
            [S]: {
                type: 'vector',
                tiles: style.tiles,
                minzoom: 0,
                maxzoom: 14,
                attribution: style.attribution || OSM_ATTRIBUTION
            }
        },
        layers: layers
    };
}

function mapStyleDefinition(type) {
    const styleKey = MAP_STYLES[type] ? type : 'nn_3d';
    const style = MAP_STYLES[styleKey];

    if (style.omt) return omtStyleDefinition(style);

    if (style.schema === 'shortbread') return versaStyleDefinition(style);

    const sourceId = 'osm-yandex-base';
    const rasterSource = {
        type: 'raster',
        tiles: style.tiles,
        tileSize: 256,
        attribution: style.attribution || '© Яндекс'
    };
    return {
        version: 8,
        sources: { [sourceId]: rasterSource },
        layers: [{ id: sourceId, type: 'raster', source: sourceId }]
    };
}

// Дорожная сетка из стиля OpenMapTiles Liberty, без спрайтовых слоёв.
// Сгенерировано из style-liberty.20260802.json: туннели + дороги + мосты + ж/д.
const LIBERTY_ROADS = [
  {"id":"tunnel_motorway_link_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"motorway"],["==",["get","ramp"],1],["==",["get","brunnel"],"tunnel"]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-dasharray":[0.5,0.25],"line-width":["interpolate",["exponential",1.2],["zoom"],12,1,13,3,14,4,20,15]}},
  {"id":"tunnel_service_track_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["service","track"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#cfcdca","line-dasharray":[0.5,0.25],"line-width":["interpolate",["exponential",1.2],["zoom"],15,1,16,4,20,11]}},
  {"id":"tunnel_link_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","ramp"],1],["==",["get","brunnel"],"tunnel"]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],12,1,13,3,14,4,20,15]}},
  {"id":"tunnel_street_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["street","street_limited"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#cfcdca","line-opacity":["interpolate",["linear"],["zoom"],12,0,12.5,1],"line-width":["interpolate",["exponential",1.2],["zoom"],12,0.5,13,1,14,4,20,15]}},
  {"id":"tunnel_secondary_tertiary_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["secondary","tertiary"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],8,1.5,20,17]}},
  {"id":"tunnel_trunk_primary_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["primary","trunk"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],5,0.4,6,0.7,7,1.75,20,22]}},
  {"id":"tunnel_motorway_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"motorway"],["!=",["get","ramp"],1],["==",["get","brunnel"],"tunnel"]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-dasharray":[0.5,0.25],"line-width":["interpolate",["exponential",1.2],["zoom"],5,0.4,6,0.7,7,1.75,20,22]}},
  {"id":"tunnel_path_pedestrian","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["geometry-type"],["LineString","MultiLineString"],true,false],["==",["get","brunnel"],"tunnel"],["match",["get","class"],["path","pedestrian"],true,false]],"paint":{"line-color":"hsl(0,0%,100%)","line-dasharray":[1,0.75],"line-width":["interpolate",["exponential",1.2],["zoom"],14,0.5,20,10]}},
  {"id":"tunnel_motorway_link","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"motorway"],["==",["get","ramp"],1],["==",["get","brunnel"],"tunnel"]],"layout":{"line-join":"round"},"paint":{"line-color":"#fc8","line-width":["interpolate",["exponential",1.2],["zoom"],12.5,0,13,1.5,14,2.5,20,11.5]}},
  {"id":"tunnel_service_track","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["service","track"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fff","line-width":["interpolate",["exponential",1.2],["zoom"],15.5,0,16,2,20,7.5]}},
  {"id":"tunnel_link","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","ramp"],1],["==",["get","brunnel"],"tunnel"]],"layout":{"line-join":"round"},"paint":{"line-color":"#fff4c6","line-width":["interpolate",["exponential",1.2],["zoom"],12.5,0,13,1.5,14,2.5,20,11.5]}},
  {"id":"tunnel_minor","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["minor"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fff","line-width":["interpolate",["exponential",1.2],["zoom"],13.5,0,14,2.5,20,11.5]}},
  {"id":"tunnel_secondary_tertiary","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["secondary","tertiary"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fff4c6","line-width":["interpolate",["exponential",1.2],["zoom"],6.5,0,7,0.5,20,10]}},
  {"id":"tunnel_trunk_primary","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["primary","trunk"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fff4c6","line-width":["interpolate",["exponential",1.2],["zoom"],5,0,7,1,20,18]}},
  {"id":"tunnel_motorway","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"motorway"],["!=",["get","ramp"],1],["==",["get","brunnel"],"tunnel"]],"layout":{"line-join":"round"},"paint":{"line-color":"#ffdaa6","line-width":["interpolate",["exponential",1.2],["zoom"],5,0,7,1,20,18]}},
  {"id":"tunnel_major_rail","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["rail"],true,false]],"paint":{"line-color":"#bbb","line-width":["interpolate",["exponential",1.4],["zoom"],14,0.4,15,0.75,20,2]}},
  {"id":"tunnel_major_rail_hatching","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["==",["get","class"],"rail"]],"paint":{"line-color":"#bbb","line-dasharray":[0.2,8],"line-width":["interpolate",["exponential",1.4],["zoom"],14.5,0,15,3,20,8]}},
  {"id":"tunnel_transit_rail","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["match",["get","class"],["transit"],true,false]],"paint":{"line-color":"#bbb","line-width":["interpolate",["exponential",1.4],["zoom"],14,0.4,15,0.75,20,2]}},
  {"id":"tunnel_transit_rail_hatching","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"tunnel"],["==",["get","class"],"transit"]],"paint":{"line-color":"#bbb","line-dasharray":[0.2,8],"line-width":["interpolate",["exponential",1.4],["zoom"],14.5,0,15,3,20,8]}},
  {"id":"road_motorway_link_casing","type":"line","source":"omt","source-layer":"transportation","minzoom":12,"filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","class"],"motorway"],["==",["get","ramp"],1]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],12,1,13,3,14,4,20,15]}},
  {"id":"road_service_track_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["service","track"],true,false]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#cfcdca","line-width":["interpolate",["exponential",1.2],["zoom"],15,1,16,4,20,11]}},
  {"id":"road_link_casing","type":"line","source":"omt","source-layer":"transportation","minzoom":13,"filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["motorway","path","pedestrian","service","track"],false,true],["==",["get","ramp"],1]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],12,1,13,3,14,4,20,15]}},
  {"id":"road_minor_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["geometry-type"],["LineString","MultiLineString"],true,false],["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["minor"],true,false],["!=",["get","ramp"],1]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#cfcdca","line-opacity":["interpolate",["linear"],["zoom"],12,0,12.5,1],"line-width":["interpolate",["exponential",1.2],["zoom"],12,0.5,13,1,14,4,20,20]}},
  {"id":"road_secondary_tertiary_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["secondary","tertiary"],true,false],["!=",["get","ramp"],1]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],8,1.5,20,17]}},
  {"id":"road_trunk_primary_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["primary","trunk"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],5,0.4,6,0.7,7,1.75,20,22]}},
  {"id":"road_motorway_casing","type":"line","source":"omt","source-layer":"transportation","minzoom":5,"filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","class"],"motorway"],["!=",["get","ramp"],1]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],5,0.4,6,0.7,7,1.75,20,22]}},
  {"id":"road_path_pedestrian","type":"line","source":"omt","source-layer":"transportation","minzoom":14,"filter":["all",["match",["geometry-type"],["LineString","MultiLineString"],true,false],["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["path","pedestrian"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"hsl(0,0%,100%)","line-dasharray":[1,0.7],"line-width":["interpolate",["exponential",1.2],["zoom"],14,1,20,10]}},
  {"id":"road_motorway_link","type":"line","source":"omt","source-layer":"transportation","minzoom":12,"filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","class"],"motorway"],["==",["get","ramp"],1]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#fc8","line-width":["interpolate",["exponential",1.2],["zoom"],12.5,0,13,1.5,14,2.5,20,11.5]}},
  {"id":"road_service_track","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["service","track"],true,false]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#fff","line-width":["interpolate",["exponential",1.2],["zoom"],15.5,0,16,2,20,7.5]}},
  {"id":"road_link","type":"line","source":"omt","source-layer":"transportation","minzoom":13,"filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","ramp"],1],["match",["get","class"],["motorway","path","pedestrian","service","track"],false,true]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#fea","line-width":["interpolate",["exponential",1.2],["zoom"],12.5,0,13,1.5,14,2.5,20,11.5]}},
  {"id":"road_minor","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["geometry-type"],["LineString","MultiLineString"],true,false],["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["minor"],true,false]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#fff","line-width":["interpolate",["exponential",1.2],["zoom"],13.5,0,14,2.5,20,18]}},
  {"id":"road_secondary_tertiary","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["secondary","tertiary"],true,false]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":"#fea","line-width":["interpolate",["exponential",1.2],["zoom"],6.5,0,8,0.5,20,13]}},
  {"id":"road_trunk_primary","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["match",["get","class"],["primary","trunk"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fea","line-width":["interpolate",["exponential",1.2],["zoom"],5,0,7,1,20,18]}},
  {"id":"road_motorway","type":"line","source":"omt","source-layer":"transportation","minzoom":5,"filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","class"],"motorway"],["!=",["get","ramp"],1]],"layout":{"line-cap":"round","line-join":"round"},"paint":{"line-color":["interpolate",["linear"],["zoom"],5,"hsl(26,87%,62%)",6,"#fc8"],"line-width":["interpolate",["exponential",1.2],["zoom"],5,0,7,1,20,18]}},
  {"id":"road_major_rail","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","class"],"rail"]],"paint":{"line-color":"#bbb","line-width":["interpolate",["exponential",1.4],["zoom"],14,0.4,15,0.75,20,2]}},
  {"id":"road_major_rail_hatching","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","class"],"rail"]],"paint":{"line-color":"#bbb","line-dasharray":[0.2,8],"line-width":["interpolate",["exponential",1.4],["zoom"],14.5,0,15,3,20,8]}},
  {"id":"road_transit_rail","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","class"],"transit"]],"paint":{"line-color":"#bbb","line-width":["interpolate",["exponential",1.4],["zoom"],14,0.4,15,0.75,20,2]}},
  {"id":"road_transit_rail_hatching","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["get","brunnel"],["bridge","tunnel"],false,true],["==",["get","class"],"transit"]],"paint":{"line-color":"#bbb","line-dasharray":[0.2,8],"line-width":["interpolate",["exponential",1.4],["zoom"],14.5,0,15,3,20,8]}},
  {"id":"bridge_motorway_link_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"motorway"],["==",["get","ramp"],1],["==",["get","brunnel"],"bridge"]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],12,1,13,3,14,4,20,15]}},
  {"id":"bridge_service_track_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"bridge"],["match",["get","class"],["service","track"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#cfcdca","line-width":["interpolate",["exponential",1.2],["zoom"],15,1,16,4,20,11]}},
  {"id":"bridge_link_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"link"],["==",["get","brunnel"],"bridge"]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],12,1,13,3,14,4,20,15]}},
  {"id":"bridge_street_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"bridge"],["match",["get","class"],["street","street_limited"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"hsl(36,6%,74%)","line-opacity":["interpolate",["linear"],["zoom"],12,0,12.5,1],"line-width":["interpolate",["exponential",1.2],["zoom"],12,0.5,13,1,14,4,20,25]}},
  {"id":"bridge_path_pedestrian_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["geometry-type"],["LineString","MultiLineString"],true,false],["==",["get","brunnel"],"bridge"],["match",["get","class"],["path","pedestrian"],true,false]],"paint":{"line-color":"hsl(35,6%,80%)","line-dasharray":[1,0],"line-width":["interpolate",["exponential",1.2],["zoom"],14,1.5,20,18]}},
  {"id":"bridge_secondary_tertiary_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"bridge"],["match",["get","class"],["secondary","tertiary"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],8,1.5,20,17]}},
  {"id":"bridge_trunk_primary_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"bridge"],["match",["get","class"],["primary","trunk"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],5,0.4,6,0.7,7,1.75,20,22]}},
  {"id":"bridge_motorway_casing","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"motorway"],["!=",["get","ramp"],1],["==",["get","brunnel"],"bridge"]],"layout":{"line-join":"round"},"paint":{"line-color":"#e9ac77","line-width":["interpolate",["exponential",1.2],["zoom"],5,0.4,6,0.7,7,1.75,20,22]}},
  {"id":"bridge_path_pedestrian","type":"line","source":"omt","source-layer":"transportation","filter":["all",["match",["geometry-type"],["LineString","MultiLineString"],true,false],["==",["get","brunnel"],"bridge"],["match",["get","class"],["path","pedestrian"],true,false]],"paint":{"line-color":"hsl(0,0%,100%)","line-dasharray":[1,0.3],"line-width":["interpolate",["exponential",1.2],["zoom"],14,0.5,20,10]}},
  {"id":"bridge_motorway_link","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"motorway"],["==",["get","ramp"],1],["==",["get","brunnel"],"bridge"]],"layout":{"line-join":"round"},"paint":{"line-color":"#fc8","line-width":["interpolate",["exponential",1.2],["zoom"],12.5,0,13,1.5,14,2.5,20,11.5]}},
  {"id":"bridge_service_track","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"bridge"],["match",["get","class"],["service","track"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fff","line-width":["interpolate",["exponential",1.2],["zoom"],15.5,0,16,2,20,7.5]}},
  {"id":"bridge_link","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"link"],["==",["get","brunnel"],"bridge"]],"layout":{"line-join":"round"},"paint":{"line-color":"#fea","line-width":["interpolate",["exponential",1.2],["zoom"],12.5,0,13,1.5,14,2.5,20,11.5]}},
  {"id":"bridge_street","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"bridge"],["match",["get","class"],["minor"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fff","line-width":["interpolate",["exponential",1.2],["zoom"],13.5,0,14,2.5,20,18]}},
  {"id":"bridge_secondary_tertiary","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"bridge"],["match",["get","class"],["secondary","tertiary"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fea","line-width":["interpolate",["exponential",1.2],["zoom"],6.5,0,7,0.5,20,10]}},
  {"id":"bridge_trunk_primary","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","brunnel"],"bridge"],["match",["get","class"],["primary","trunk"],true,false]],"layout":{"line-join":"round"},"paint":{"line-color":"#fea","line-width":["interpolate",["exponential",1.2],["zoom"],5,0,7,1,20,18]}},
  {"id":"bridge_motorway","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"motorway"],["!=",["get","ramp"],1],["==",["get","brunnel"],"bridge"]],"layout":{"line-join":"round"},"paint":{"line-color":"#fc8","line-width":["interpolate",["exponential",1.2],["zoom"],5,0,7,1,20,18]}},
  {"id":"bridge_major_rail","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"rail"],["==",["get","brunnel"],"bridge"]],"paint":{"line-color":"#bbb","line-width":["interpolate",["exponential",1.4],["zoom"],14,0.4,15,0.75,20,2]}},
  {"id":"bridge_major_rail_hatching","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"rail"],["==",["get","brunnel"],"bridge"]],"paint":{"line-color":"#bbb","line-dasharray":[0.2,8],"line-width":["interpolate",["exponential",1.4],["zoom"],14.5,0,15,3,20,8]}},
  {"id":"bridge_transit_rail","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"transit"],["==",["get","brunnel"],"bridge"]],"paint":{"line-color":"#bbb","line-width":["interpolate",["exponential",1.4],["zoom"],14,0.4,15,0.75,20,2]}},
  {"id":"bridge_transit_rail_hatching","type":"line","source":"omt","source-layer":"transportation","filter":["all",["==",["get","class"],"transit"],["==",["get","brunnel"],"bridge"]],"paint":{"line-color":"#bbb","line-dasharray":[0.2,8],"line-width":["interpolate",["exponential",1.4],["zoom"],14.5,0,15,3,20,8]}}
];
