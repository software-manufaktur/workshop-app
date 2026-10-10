import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "de.seeyou.workshops",
  appName: "SeeYou",
  webDir: "dist",
  ios: {
    contentInset: "never",
    backgroundColor: "#FFFFFF",
  },
};

export default config;
