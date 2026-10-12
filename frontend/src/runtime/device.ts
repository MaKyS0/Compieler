// Real information about the device the app runs on, exposed to programs as DEVICE_* environment variables
// (os.environ in Python, process.env in JavaScript, getenv in C++). Nothing is invented: values come from the
// Android app (Build, /proc, ActivityManager, DisplayMetrics, battery) or, in a plain browser, from the Web APIs.
// Fields the platform does not reveal are simply absent.
export type DeviceEnv = Record<string, string>;

interface AndroidDeviceBridge {
  deviceInfo?: () => string;
}

const MAX_AGE_MS = 5_000;
let cache: { at: number; env: DeviceEnv } | null = null;

function set(env: DeviceEnv, key: string, value: unknown) {
  if (value === undefined || value === null) return;
  const s = String(value).trim();
  if (s) env[`DEVICE_${key}`] = s;
}

async function webInfo(env: DeviceEnv) {
  const n = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
    userAgentData?: {
      platform?: string;
      mobile?: boolean;
      getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
    };
    getBattery?: () => Promise<{ level: number; charging: boolean }>;
  };
  set(env, "USER_AGENT", n.userAgent);
  set(env, "WEB_PLATFORM", n.userAgentData?.platform ?? n.platform);
  set(env, "CPU_CORES", n.hardwareConcurrency);
  // deviceMemory is rounded and capped by browsers (max 8 GB): informational only
  set(env, "RAM_APPROX_GB_WEB", n.deviceMemory);
  set(env, "SCREEN_CSS", `${screen.width}x${screen.height}`);
  set(env, "PIXEL_RATIO", window.devicePixelRatio);
  set(env, "LOCALE", n.language);
  set(env, "TIMEZONE", Intl.DateTimeFormat().resolvedOptions().timeZone);
  set(env, "ONLINE", n.onLine);
  if (n.connection) {
    set(env, "NET_TYPE", n.connection.effectiveType);
    set(env, "NET_DOWNLINK_MBPS", n.connection.downlink);
    set(env, "NET_RTT_MS", n.connection.rtt);
  }
  try {
    const hi = await n.userAgentData?.getHighEntropyValues?.(["model", "platformVersion", "architecture", "bitness", "fullVersionList"]);
    if (hi) {
      set(env, "MODEL", hi.model);
      set(env, "OS_VERSION", hi.platformVersion);
      set(env, "ARCH", hi.architecture);
      set(env, "BITNESS", hi.bitness);
    }
  } catch {
    /* not available */
  }
  try {
    const b = await n.getBattery?.();
    if (b) {
      set(env, "BATTERY_PERCENT", Math.round(b.level * 100));
      set(env, "BATTERY_STATUS", b.charging ? "charging" : "discharging");
    }
  } catch {
    /* not available */
  }
}

/** Collects the current device information (cached for a few seconds). */
export async function collectDeviceInfo(): Promise<DeviceEnv> {
  if (cache && Date.now() - cache.at < MAX_AGE_MS) return cache.env;
  const env: DeviceEnv = {};
  const bridge = (window as unknown as { AndroidBridge?: AndroidDeviceBridge }).AndroidBridge;
  set(env, "SOURCE", "browser");
  await webInfo(env);
  if (bridge?.deviceInfo) {
    try {
      // native values win over what the web layer could guess
      const native = JSON.parse(bridge.deviceInfo()) as Record<string, string>;
      for (const [k, v] of Object.entries(native)) set(env, k, v);
    } catch {
      /* keep the web values */
    }
  }
  cache = { at: Date.now(), env };
  return env;
}
