import { BOOL_CODEC, useLocalStorage } from "../ui/ui";

// off by default: a selection behaves as in any terminal; on, it offers Copy / Reply
export const useSelectionBubble = () => useLocalStorage("trame:termSelectionBubble", false, BOOL_CODEC);
