import { defineConfig } from "vitest/config";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  // Relative Pfade: funktioniert auf GitHub Pages (Unterordner) und in der iOS-App
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: "safari15",
    sourcemap: false,
  },
  plugins: [
    tailwindcss(),
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      includeAssets: ["icons/apple-touch-icon.png", "logo-160.png", "bg.jpg"],
      manifest: {
        name: "SeeYou Workshops",
        short_name: "SeeYou",
        description: "Termin- und Buchungsverwaltung für SeeYou-Workshops",
        lang: "de",
        start_url: "./",
        scope: "./",
        display: "standalone",
        theme_color: "#AF9778",
        background_color: "#FFFFFF",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,jpg,svg,webmanifest}"],
        cleanupOutdatedCaches: true,
        navigateFallback: "index.html",
      },
    }),
  ],
  test: {
    environment: "node",
  },
});
