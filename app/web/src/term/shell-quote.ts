// a POSIX shell word: as is when safe, else single-quoted
export const shellWord = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", `'\\''`)}'`);

// files dropped on the window, forwarded by the desktop shell (crates/trame-desktop) in CSS pixels
export const FILE_DROP = "trame:file-drop";
export type FileDrop = { paths: string[]; x: number; y: number };
