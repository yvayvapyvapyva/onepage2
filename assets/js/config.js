// API конфигурация
const API_CONFIG = {
  YANDEX_MAPS_V2_KEY: 'YANDEX_API_KEY',
  YANDEX_MAPS_V3_KEY: 'c0e28937-4e16-4d15-9b99-09a30cb8fc13'
};

const ROUTE_DATA = {
  Gold: { hex: '#FFD700', label: 'Маневры на перекрестке' },
  Blue: { hex: '#007AFF', label: 'Разворот вне перекрестка' },
  Red: { hex: '#FF3B30', label: 'Разгон до максимальной скорости' },
  Fuchsia: { hex: '#AF52DE', label: 'Остановка и начало движения на подъем' },
  Orange: { hex: '#FF9500', label: 'Левые и правые повороты' },
  Purple: { hex: '#5856D6', label: 'Параллельная парковка и гараж' },
  Cyan: { hex: '#5AC8FA', label: 'Разворот в ограниченном пространстве' },
  Brown: { hex: '#A2845E', label: 'Остановка' },
  Lime: { hex: '#34C759', label: 'Начало движения' }
};

const COLORS = Object.fromEntries(
  Object.entries(ROUTE_DATA).map(([k, v]) => [k, { hex: v.hex, label: v.label }])
);
const ZNAKI = ['1.png','2.png','3.png','4.png','5.png','10.png','2.4.png','2.5.png','20.png','3.1.png','3.27.png','3.31.png','30.png','4.1.1.png','4.1.2.png','40.png','5.15.2.png','5.19.1.png','5.19.2.png','5.21.png','5.5.png','50.png','6.16.png','6.3.1.png','6.4.png','sve.png'];
