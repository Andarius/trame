import type { StatusDef } from "./api";
import { GroupIcon } from "./icons";
import { StatusManager } from "./StatusManager";
import { EntityIcon, MENU_LABEL, MenuRow, Popover } from "./ui";
import { useState } from "react";
import type { View } from "./view";

type Group = "none" | "story" | "project";

export function BoardToolbar(
  { view, group, onGroup, dense, onDense, hideEmpty, onHideEmpty, statuses, onStatusesChanged }: {
    view: View;
    group: Group;
    onGroup: (g: Group) => void;
    dense: boolean;
    onDense: (f: (v: boolean) => boolean) => void;
    hideEmpty: boolean;
    onHideEmpty: (f: (v: boolean) => boolean) => void;
    statuses: StatusDef[];
    onStatusesChanged: () => void;
  },
) {
  const [groupMenu, setGroupMenu] = useState(false);
  const [colMenu, setColMenu] = useState(false);
  return (
    <>
      {view === "board" && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setGroupMenu((o) => !o)}
            title="Group the board"
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] ${
              group !== "none"
                ? "border-copper/50 text-copper"
                : "border-line text-ink-muted hover:text-ink-soft"
            }`}
          >
            <GroupIcon />
            {group === "none"
              ? "Group"
              : group === "story"
              ? "User story"
              : "Project"}
            <span className="text-[8px]">▾</span>
          </button>
          {groupMenu && (
            <Popover onClose={() => setGroupMenu(false)} className="w-40">
              <div className={`px-2 pb-1 pt-1 ${MENU_LABEL}`}>
                GROUP BY
              </div>
              {([["none", "None", null], ["story", "User story", "◇"], ["project", "Project", "◎"]] as const).map((
                [v, label, glyph],
              ) => (
                <MenuRow
                  dense
                  key={v}
                  onClick={() => {
                    onGroup(v);
                    setGroupMenu(false);
                  }}
                  active={group === v}
                >
                  {glyph && <EntityIcon icon={null} fallback={glyph} className="text-ink-muted" />}
                  <span className="flex-1">{label}</span>
                  {group === v && (
                    <span className="text-[11px] text-copper">✓</span>
                  )}
                </MenuRow>
              ))}
            </Popover>
          )}
        </div>
      )}
      {view === "board" && (
        <button
          type="button"
          onClick={() => onDense((v) => !v)}
          title="One line per card"
          aria-pressed={dense}
          className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] ${
            dense ? "border-copper/50 text-copper" : "border-line text-ink-muted hover:text-ink-soft"
          }`}
        >
          <span className="text-[11px]">≡</span>
          Compact
        </button>
      )}
      {view === "board" && (
        <div className="relative">
          <button
            type="button"
            onClick={() => setColMenu((o) => !o)}
            title="Columns"
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11.5px] ${
              hideEmpty
                ? "border-copper/50 text-copper"
                : "border-line text-ink-muted hover:text-ink-soft"
            }`}
          >
            <span className="text-[11px]">▤</span>
            Columns
            <span className="text-[8px]">▾</span>
          </button>
          {colMenu && (
            <Popover
              onClose={() => setColMenu(false)}
              className="w-[264px]"
            >
              <MenuRow onClick={() => onHideEmpty((v) => !v)}>
                <span
                  className={`flex h-3.5 w-3.5 items-center justify-center rounded border text-[9px] ${
                    hideEmpty
                      ? "border-copper bg-copper text-copper-ink"
                      : "border-chipline"
                  }`}
                >
                  {hideEmpty ? "✓" : ""}
                </span>
                <span className="flex-1">Hide empty statuses</span>
              </MenuRow>
              <StatusManager
                statuses={statuses}
                onChanged={onStatusesChanged}
              />
            </Popover>
          )}
        </div>
      )}
    </>
  );
}
