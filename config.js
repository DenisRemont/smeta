// Прайс и настройки читаются из опубликованной Google Таблицы (Файл → Поделиться → Опубликовать в интернете).
// Копия в data/ — запасной вариант, если Google не ответил, а на телефоне ещё нет сохранённого прайса.
const SHEET = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTuBAzJ5pm0p3wtiNanfpL4LDx454iIs5e035iEAZMe-KwMHbSoeKYyWe2F6sTMgJK1PE_ZcH_DCfKE/pub?single=true&output=csv';

window.SMETA_CONFIG = {
  pricesUrl: `${SHEET}&gid=0`,
  settingsUrl: `${SHEET}&gid=1743334422`,
  backupPricesUrl: 'data/prices.csv',
  backupSettingsUrl: 'data/settings.csv',
};
