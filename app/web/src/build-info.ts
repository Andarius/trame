// stamped by vite.config.ts at build time
declare const __BUILD_TIME__: string;
export const BUILD_TIME = new Date(__BUILD_TIME__);
export const buildClock = () => BUILD_TIME.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
