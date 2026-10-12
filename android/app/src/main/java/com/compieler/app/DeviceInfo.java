package com.compieler.app;

import android.app.ActivityManager;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.BatteryManager;
import android.os.Build;
import android.os.Environment;
import android.os.StatFs;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.Display;
import android.webkit.WebView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Real hardware / OS information, read straight from Android. Nothing here is faked or randomised.
 * Only data that needs no permission is collected; serial numbers, IMEI, MAC and advertising ids are never touched.
 */
final class DeviceInfo {
    private DeviceInfo() {}

    static String collect(Context ctx) {
        JSONObject o = new JSONObject();
        put(o, "SOURCE", "android-native");
        put(o, "MANUFACTURER", Build.MANUFACTURER);
        put(o, "BRAND", Build.BRAND);
        put(o, "MODEL", Build.MODEL);
        put(o, "NAME", Build.DEVICE);
        put(o, "PRODUCT", Build.PRODUCT);
        put(o, "HARDWARE", Build.HARDWARE);
        put(o, "BOARD", Build.BOARD);
        put(o, "ANDROID_RELEASE", Build.VERSION.RELEASE);
        put(o, "ANDROID_SDK", String.valueOf(Build.VERSION.SDK_INT));
        put(o, "ANDROID_SECURITY_PATCH", Build.VERSION.SECURITY_PATCH);
        put(o, "ANDROID_BUILD", Build.DISPLAY);
        put(o, "ABIS", String.join(",", Build.SUPPORTED_ABIS));
        put(o, "KERNEL", System.getProperty("os.version"));
        put(o, "KERNEL_ARCH", System.getProperty("os.arch"));
        put(o, "CPU_CORES", String.valueOf(Runtime.getRuntime().availableProcessors()));
        if (Build.VERSION.SDK_INT >= 31) {
            put(o, "SOC", Build.SOC_MANUFACTURER + " " + Build.SOC_MODEL);
        }
        cpu(o);
        memory(ctx, o);
        storage(o);
        display(ctx, o);
        battery(ctx, o);
        try {
            android.content.pm.PackageInfo wv = WebView.getCurrentWebViewPackage();
            if (wv != null) put(o, "WEBVIEW", wv.packageName + " " + wv.versionName);
        } catch (Throwable ignored) {}
        put(o, "LOCALE", Locale.getDefault().toLanguageTag());
        put(o, "TIMEZONE", TimeZone.getDefault().getID());
        put(o, "UPTIME_S", String.valueOf(SystemClock.elapsedRealtime() / 1000));
        return o.toString();
    }

    private static void put(JSONObject o, String key, String value) {
        if (value == null || value.isEmpty() || value.equals("null") || value.equals("unknown")) return;
        try { o.put(key, value); } catch (Exception ignored) {}
    }

    private static void cpu(JSONObject o) {
        try (BufferedReader r = new BufferedReader(new FileReader("/proc/cpuinfo"))) {
            String line, name = null, hardware = null;
            while ((line = r.readLine()) != null) {
                int i = line.indexOf(':');
                if (i < 0) continue;
                String k = line.substring(0, i).trim(), v = line.substring(i + 1).trim();
                if (k.equals("Hardware")) hardware = v;
                else if (k.equals("model name") && name == null) name = v;
            }
            put(o, "CPU_NAME", hardware != null ? hardware : name);
        } catch (Exception ignored) {}
        // per-core maximum frequency (not readable on every device)
        try {
            int n = Runtime.getRuntime().availableProcessors();
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < n; i++) {
                File f = new File("/sys/devices/system/cpu/cpu" + i + "/cpufreq/cpuinfo_max_freq");
                if (!f.canRead()) continue;
                try (BufferedReader r = new BufferedReader(new FileReader(f))) {
                    long khz = Long.parseLong(r.readLine().trim());
                    if (sb.length() > 0) sb.append(',');
                    sb.append(khz / 1000);
                }
            }
            put(o, "CPU_MAX_MHZ_PER_CORE", sb.toString());
        } catch (Exception ignored) {}
    }

    private static void memory(Context ctx, JSONObject o) {
        try {
            ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            put(o, "RAM_TOTAL_MB", String.valueOf(mi.totalMem / 1048576));
            put(o, "RAM_AVAILABLE_MB", String.valueOf(mi.availMem / 1048576));
            put(o, "RAM_LOW", String.valueOf(mi.lowMemory));
            put(o, "APP_HEAP_LIMIT_MB", String.valueOf(am.getMemoryClass()));
        } catch (Exception ignored) {}
    }

    private static void storage(JSONObject o) {
        try {
            StatFs s = new StatFs(Environment.getDataDirectory().getPath());
            put(o, "STORAGE_TOTAL_GB", String.format(Locale.US, "%.1f", s.getTotalBytes() / 1e9));
            put(o, "STORAGE_FREE_GB", String.format(Locale.US, "%.1f", s.getAvailableBytes() / 1e9));
        } catch (Exception ignored) {}
    }

    private static void display(Context ctx, JSONObject o) {
        try {
            android.view.WindowManager wm = (android.view.WindowManager) ctx.getSystemService(Context.WINDOW_SERVICE);
            DisplayMetrics m = new DisplayMetrics();
            Display d = wm.getDefaultDisplay();
            d.getRealMetrics(m);
            put(o, "SCREEN_PX", m.widthPixels + "x" + m.heightPixels);
            put(o, "SCREEN_DPI", String.valueOf(m.densityDpi));
            put(o, "SCREEN_DENSITY", String.format(Locale.US, "%.2f", m.density));
            put(o, "SCREEN_REFRESH_HZ", String.format(Locale.US, "%.0f", d.getRefreshRate()));
        } catch (Exception ignored) {}
    }

    private static void battery(Context ctx, JSONObject o) {
        try {
            Intent b = ctx.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (b == null) return;
            int level = b.getIntExtra(BatteryManager.EXTRA_LEVEL, -1), scale = b.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            if (level >= 0 && scale > 0) put(o, "BATTERY_PERCENT", String.valueOf(level * 100 / scale));
            int status = b.getIntExtra(BatteryManager.EXTRA_STATUS, -1);
            put(o, "BATTERY_STATUS", status == BatteryManager.BATTERY_STATUS_CHARGING ? "charging"
                    : status == BatteryManager.BATTERY_STATUS_FULL ? "full"
                    : status == BatteryManager.BATTERY_STATUS_DISCHARGING ? "discharging"
                    : status == BatteryManager.BATTERY_STATUS_NOT_CHARGING ? "not charging" : null);
            int temp = b.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, Integer.MIN_VALUE);
            if (temp != Integer.MIN_VALUE) put(o, "BATTERY_TEMP_C", String.format(Locale.US, "%.1f", temp / 10.0));
            int mv = b.getIntExtra(BatteryManager.EXTRA_VOLTAGE, -1);
            if (mv > 0) put(o, "BATTERY_VOLTAGE_MV", String.valueOf(mv));
        } catch (Exception ignored) {}
    }
}
