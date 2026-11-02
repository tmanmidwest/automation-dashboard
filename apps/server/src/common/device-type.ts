/**
 * What kind of thing a network client is ("Smart TV", "Printer"…), for when the network
 * gear doesn't say. Two sources, best first:
 *
 * 1. UniFi's own fingerprint database (the names its app shows), when the console serves
 *    it — see {@link parseFingerprintDb} / {@link fingerprintType}.
 * 2. Rules on the device's name and maker below. These are guesses and are labelled so.
 *
 * A type the user sets in Cerebro beats both (applied by the topology service).
 */

export interface DeviceTypeGuess {
  type: string;
  /** Product name when the fingerprint knows it, e.g. "Roku TV". */
  model?: string;
  /** Where it came from, shown next to the type. */
  source: 'UniFi fingerprint' | 'Guess from name' | 'Guess from maker';
}

/** Names people give devices / devices give themselves. Checked before the maker. */
const NAME_RULES: [RegExp, string][] = [
  [/fellow|aiden|coffee|espresso|brew|kettle|keurig|nespresso/i, 'Coffee maker'],
  [/garage/i, 'Garage door controller'],
  [/net_ac_|\bac[-_ ]?unit|mini-?split|hvac|air-?con/i, 'Air conditioner / HVAC'],
  [/wled|led-?strip|govee/i, 'LED lighting controller'],
  [/unas|\bnas\b|synology|diskstation|qnap|truenas/i, 'NAS / storage'],
  [/roku/i, 'Streaming player / Roku TV'],
  [/apple-?tv|appletv/i, 'Streaming player (Apple TV)'],
  [/fire-?tv|firestick|aft[a-z]{2,}/i, 'Streaming player (Fire TV)'],
  [/chromecast|google-?tv/i, 'Streaming player (Chromecast)'],
  [/shield/i, 'Streaming player (NVIDIA Shield)'],
  [/\btv\b|-tv\b|tv-|bravia|vizio|smarttv|webos/i, 'Smart TV'],
  [/iphone|pixel|galaxy-?s|android|oneplus|moto/i, 'Phone'],
  [/ipad|galaxy-?tab|kindle|fire-?hd/i, 'Tablet'],
  [/macbook|laptop|thinkpad|surface|chromebook/i, 'Laptop'],
  [/imac|mac-?mini|mac-?studio|desktop|\bpc\b|workstation/i, 'Computer'],
  [/watch/i, 'Smartwatch'],
  [/printer|officejet|deskjet|laserjet|epson|brother|canon|mfc-/i, 'Printer'],
  [/doorbell/i, 'Doorbell camera'],
  [/cam(era)?\b|cam-|ipcam|reolink|wyze|blink/i, 'Camera'],
  [/echo|alexa|google-?home|nest-?(mini|hub|audio)|homepod/i, 'Smart speaker'],
  [/sonos/i, 'Speaker (Sonos)'],
  [/xbox|playstation|\bps[345]\b|nintendo|switch-?console/i, 'Game console'],
  [/thermostat|ecobee|nest-?(learning|thermostat)/i, 'Thermostat'],
  [/\bhue\b|bulb|light|lamp|lutron|caseta/i, 'Smart lighting'],
  [/plug|outlet|kasa|wemo|shelly|tasmota/i, 'Smart plug'],
  [/\besp(32|8266)?[a-z0-9]*[-_]/i, 'Smart home device (ESP32 board)'],
  [/vacuum|roomba|roborock|ecovacs/i, 'Robot vacuum'],
  [/washer|dryer|fridge|oven|dishwasher|\brange\b/i, 'Appliance'],
  [/raspberry|\bpi\d?\b|-pi\b/i, 'Raspberry Pi'],
];

/** IEEE / UniFi maker names. Only makers that mostly build one kind of thing. */
const MAKER_RULES: [RegExp, string][] = [
  [/hisense|qingdao intelligent/i, 'Smart TV (Hisense)'],
  [/\broku\b/i, 'Streaming player / Roku TV'],
  [/\btcl\b|tcl king/i, 'Smart TV (TCL)'],
  [/vizio/i, 'Smart TV (Vizio)'],
  [/sonos/i, 'Speaker (Sonos)'],
  // Wi-Fi chip / module makers: they're inside everything from plugs to coffee makers,
  // so the maker alone only says "some smart home gadget".
  [/espressif|beken|shenzhen bilian|hui zhou gaoshengda|realtek semiconductor.*iot/i, 'Smart home device (Wi-Fi module)'],
  [/tuya/i, 'Smart home device (Tuya)'],
  [/midea|gree electric|daikin|carrier|lennox|fujitsu general/i, 'Air conditioner / HVAC'],
  [/\bring\b|ring llc/i, 'Camera (Ring)'],
  [/wyze|reolink|hikvision|dahua|amcrest|arlo/i, 'Camera'],
  [/ecobee/i, 'Thermostat'],
  [/nest labs/i, 'Nest device'],
  [/signify|philips lighting|lutron|lifx/i, 'Smart lighting'],
  [/irobot|roborock|ecovacs/i, 'Robot vacuum'],
  [/nintendo/i, 'Game console (Nintendo)'],
  [/sony interactive/i, 'Game console (PlayStation)'],
  [/seiko epson|brother industries|canon inc/i, 'Printer'],
  [/synology|qnap/i, 'NAS / storage'],
  [/raspberry pi/i, 'Raspberry Pi'],
  [/proxmox server solutions/i, 'Virtual machine (Proxmox)'],
  [/vmware/i, 'Virtual machine (VMware)'],
  [/ubiquiti/i, 'UniFi / Ubiquiti device'],
  [/fellow industries|fellow products/i, 'Coffee maker (Fellow)'],
  [/amazon technologies/i, 'Amazon device (Echo, Fire TV, Kindle)'],
  [/google/i, 'Google device (Nest, Chromecast, Pixel)'],
  [/apple/i, 'Apple device'],
  [/samsung/i, 'Samsung device (phone, TV or appliance)'],
  [/intel corporate|dell|lenovo|micro-star|asustek|gigabyte/i, 'Computer'],
];

/** Guess from the client's name/hostname, then its maker. Null when nothing matches. */
export function guessDeviceType(d: { name?: string | null; hostname?: string | null; vendor?: string | null }): DeviceTypeGuess | null {
  for (const n of [d.name, d.hostname]) {
    if (!n || /^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/i.test(n)) continue;
    const hit = NAME_RULES.find(([re]) => re.test(n));
    if (hit) return { type: hit[1], source: 'Guess from name' };
  }
  if (d.vendor) {
    const hit = MAKER_RULES.find(([re]) => re.test(d.vendor!));
    if (hit) return { type: hit[1], source: 'Guess from maker' };
  }
  return null;
}

// ── UniFi fingerprint database ────────────────────────────────────────────────

export interface FingerprintDb {
  devices: Map<string, string>;
  types: Map<string, string>;
  families: Map<string, string>;
  vendors: Map<string, string>;
}

/** Fingerprint ids UniFi puts on a client record. */
export interface FingerprintIds {
  dev_id?: number | string;
  dev_id_override?: number | string;
  dev_cat?: number | string;
  dev_family?: number | string;
  dev_vendor?: number | string;
}

function idMap(v: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!v || typeof v !== 'object') return out;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    const name = typeof x === 'string' ? x : x && typeof x === 'object' ? (x as { name?: unknown; display_name?: unknown }).name ?? (x as { display_name?: unknown }).display_name : null;
    if (typeof name === 'string' && name.trim()) out.set(String(k), name.trim());
  }
  return out;
}

/**
 * Parse the console's fingerprint table (`/proxy/network/v2/api/fingerprint_devices/0`),
 * which maps the numeric ids on each client to names. Returns null when it doesn't look
 * like one, so an unexpected shape just falls back to the rules.
 */
export function parseFingerprintDb(raw: unknown): FingerprintDb | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const db: FingerprintDb = {
    devices: idMap(r.dev_ids),
    types: idMap(r.dev_type_ids ?? r.dev_cat_ids),
    families: idMap(r.family_ids ?? r.dev_family_ids),
    vendors: idMap(r.vendor_ids ?? r.dev_vendor_ids),
  };
  return db.devices.size || db.types.size || db.families.size ? db : null;
}

export function fingerprintType(db: FingerprintDb | null | undefined, c: FingerprintIds): DeviceTypeGuess | null {
  if (!db) return null;
  const key = (v: unknown) => (v == null || v === '' ? null : String(v));
  const devId = key(c.dev_id_override) ?? key(c.dev_id);
  const model = devId ? db.devices.get(devId) : undefined;
  const cat = key(c.dev_cat);
  const fam = key(c.dev_family);
  const type = (cat && db.types.get(cat)) || (fam && db.families.get(fam)) || undefined;
  if (!type && !model) return null;
  const vendor = key(c.dev_vendor);
  const maker = vendor ? db.vendors.get(vendor) : undefined;
  return {
    type: type ?? model!,
    model: model && model !== type ? (maker && !model.toLowerCase().includes(maker.toLowerCase()) ? `${maker} ${model}` : model) : undefined,
    source: 'UniFi fingerprint',
  };
}
