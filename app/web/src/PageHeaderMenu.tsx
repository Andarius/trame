import { getPage, type PageDetail, pageToSession, pageToStory, type updatePage } from "./api";
import { appConfirm, EntityIcon, MenuRow, Popover, timeAgo, uuid7Time, IconButton } from "./ui";
import { label } from "./modal-ui";
import { TagEditor } from "./TagEditor";

export function PageHeaderMenu(
  {
    page,
    patch,
    canConvert,
    underStory,
    headerMenu,
    setHeaderMenu,
    idCopied,
    setIdCopied,
    onShowMarkdown,
    setPage,
    onChanged,
    onOpenSession,
  }: {
    page: PageDetail;
    patch: (p: Parameters<typeof updatePage>[1]) => Promise<void>;
    canConvert: boolean;
    underStory: boolean;
    headerMenu: boolean;
    setHeaderMenu: (v: boolean | ((v: boolean) => boolean)) => void;
    idCopied: boolean;
    setIdCopied: (v: boolean) => void;
    onShowMarkdown: () => void;
    setPage: (p: PageDetail) => void;
    onChanged: () => void;
    onOpenSession: (id: string, full?: boolean) => void;
  },
) {
        const created = uuid7Time(page.id);
            const item =
          "rounded text-[12.5px]";
        return (
          <div className="-mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-[11px] text-ink-muted/70">
            {created && (
              <span title={created.toLocaleString()}>
                Created {created.toLocaleDateString(undefined, {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </span>
            )}
            {created && <span>·</span>}
            <span title={new Date(page.updated_at).toLocaleString()}>
              Updated {timeAgo(page.updated_at)}
            </span>
            <span className="mx-1 h-3 w-px bg-line" />
            <TagEditor
              tags={page.tags ?? []}
              onChange={(tags) => patch({ tags })}
            />
            <span className="flex-1" />
            {/* rarely-used page actions, out of the metadata line */}
            <div className="relative">
              <button
                type="button"
                title="More page actions"
                aria-label="More page actions"
                aria-haspopup="menu"
                aria-expanded={headerMenu}
                className="rounded-md px-1.5 py-0.5 text-[15px] leading-none text-ink-muted hover:bg-panel hover:text-ink-soft"
                onClick={() => setHeaderMenu((v) => !v)}
              >
                ⋯
              </button>
              {headerMenu && (
                <Popover onClose={() => setHeaderMenu(false)} className="!left-auto right-0 w-[230px]">
                  <MenuRow
                    className={item}
                    onClick={() => {
                      navigator.clipboard?.writeText(page.id).then(() => {
                        setIdCopied(true);
                        setTimeout(() => setIdCopied(false), 1500);
                      }).catch(() => {});
                    }}
                  >
                    ⧉ {idCopied ? "Copied ✓" : "Copy page id"}
                  </MenuRow>
                  <MenuRow
                    className={item}
                    onClick={() => {
                      setHeaderMenu(false);
                      onShowMarkdown();
                    }}
                  >
                    ⌘ Show as Markdown
                  </MenuRow>
                  {canConvert && (
                    <MenuRow
                      className={item}
                      title="Track this page as a session — the page becomes the card's specs"
                      onClick={() => {
                        setHeaderMenu(false);
                        pageToSession(page.id)
                          .then((r) => {
                            onChanged(); // the drawer renders only once the board has the card
                            onOpenSession(r.id, true);
                          })
                          .catch((e: Error) => appConfirm(e.message, "OK"));
                      }}
                    >
                      ▦ Convert to session
                    </MenuRow>
                  )}
                  {canConvert && page.kind === "page" && !underStory && (
                    <MenuRow
                      className={item}
                      title="Make this page a user story under its project — cards will attach to it"
                      onClick={() => {
                        setHeaderMenu(false);
                        pageToStory(page.id)
                          .then(() => {
                            onChanged();
                            getPage(page.id).then(setPage);
                          })
                          .catch((e: Error) => appConfirm(e.message, "OK"));
                      }}
                    >
                      <EntityIcon icon={null} fallback="◇" /> Convert to user story
                    </MenuRow>
                  )}
                </Popover>
              )}
            </div>
          </div>
        );
}

export function MarkdownPanel(
  { markdown, copied, setCopied, onClose }: {
    markdown: string;
    copied: boolean;
    setCopied: (v: boolean) => void;
    onClose: () => void;
  },
) {
  return (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 pt-[10vh]"
          onClick={() => onClose()}
        >
          <div
            className="flex max-h-[76vh] w-[min(760px,90vw)] flex-col gap-3 overflow-hidden rounded-xl border border-overlay-border bg-panel-modal p-5 shadow-2xl shadow-black/50"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <span className={label}>
                MARKDOWN
              </span>
              <span className="flex-1" />
              <button
                type="button"
                className={`rounded-md border border-line-soft px-2 py-0.5 text-[11px] transition-colors ${
                  copied ? "border-copper/50 text-copper" : "text-ink-muted hover:bg-panel hover:text-ink-soft"
                }`}
                onClick={() => {
                  navigator.clipboard
                    ?.writeText(markdown)
                    .then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }).catch(() => {});
                }}
              >
                {copied ? "copied ✓" : "copy"}
              </button>
              <IconButton tone="close" className="rounded-md px-1.5 py-0.5 text-[13px] transition-colors hover:bg-panel"
                title="close"
                onClick={() => onClose()}
              >
                ✕
              </IconButton>
            </div>
            <pre className="overflow-auto whitespace-pre-wrap rounded-md border border-line-soft bg-panel px-3 py-2 font-mono text-[12px] leading-relaxed text-ink">
              {markdown}
            </pre>
          </div>
        </div>
  );
}
