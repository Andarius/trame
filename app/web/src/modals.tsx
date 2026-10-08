import { useState } from "react";
import type { BoardData, Status } from "./api";
import { Footer, input, label, pill, STORY_PLACEHOLDER } from "./modal-ui";
import { Modal, pageOptions, Select, StatusDot } from "./ui";

export function NewSessionModal(
  { board, onClose, onCreate }: {
    board: BoardData;
    onClose: () => void;
    onCreate: (s: Record<string, unknown>) => void;
  },
) {
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<Status>(board.statuses[0]?.key ?? "active");
  const [client, setClient] = useState(board.projects[0]?.name ?? "");
  const [story, setStory] = useState("");
  const [newStory, setNewStory] = useState("");
  const [branch, setBranch] = useState("");
  const [nextStep, setNextStep] = useState("");

  const submit = () => {
    if (!title.trim()) return;
    onCreate({
      title: title.trim(),
      status,
      client: client || undefined,
      // an existing pick is a page id (plain pages get promoted); __new__ is a title
      ...(story === "__new__" ? { story: newStory || undefined } : { page_id: story || undefined }),
      branch: branch || undefined,
      next_step: nextStep || undefined,
    });
  };

  return (
    <Modal onClose={onClose} onSubmit={submit}>
      <div className={label}>NEW SESSION</div>
      <input
        autoFocus
        className={`${input} text-base font-semibold`}
        placeholder="repo — short topic"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="flex items-center gap-1.5 rounded-md border border-chipline py-1 pl-2 pr-1">
          <StatusDot status={status} size={7} />
          <Select
            value={status}
            className="bg-transparent px-1 text-[11.5px] text-ink-soft outline-none"
            options={board.statuses.map((s) => ({ value: s.key, label: s.label }))}
            onChange={(v) => setStatus(v as Status)}
          />
        </span>
        <Select
          value={client}
          className={pill}
          options={board.projects.map((c) => ({ value: c.name, label: c.name }))}
          onChange={setClient}
        />
        <Select
          value={story}
          className={pill}
          options={[
            { value: "", label: "no story", icon: "◇" },
            ...pageOptions(
              board.stories.filter((s) => s.status !== "archived"),
              board.pages ?? [],
            ),
            { value: "__new__", label: "＋ new story…" },
          ]}
          onChange={setStory}
        />
        <input
          className={`${pill} w-36`}
          placeholder="⎇ branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />
      </div>
      {story === "__new__" && (
        <input
          className={`${pill} w-full`}
          placeholder="new story title (created on save)"
          value={newStory}
          onChange={(e) => setNewStory(e.target.value)}
        />
      )}
      <div className="flex items-center gap-2 text-[12.5px]">
        <span className="text-ink-soft">→</span>
        <input
          className={`${input} text-[12.5px]`}
          placeholder="next step (imperative, one line)"
          value={nextStep}
          onChange={(e) => setNextStep(e.target.value)}
        />
      </div>
      <Footer
        hint="/project:track fills all of this automatically from a repo"
        action="Create session"
        onClose={onClose}
        onSubmit={submit}
        disabled={!title.trim()}
      />
    </Modal>
  );
}

export function NewUdbModal(
  { onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void },
) {
  const [name, setName] = useState("");
  const submit = () => name.trim() && onCreate(name.trim());
  return (
    <Modal width={440} onClose={onClose} onSubmit={submit}>
      <div className={label}>NEW DATABASE</div>
      <input
        autoFocus
        className={`${input} text-base font-semibold`}
        placeholder="e.g. Benchmarks, Metrics log…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      <Footer
        hint="columns are added from the table's “+” header cell"
        action="Create database"
        onClose={onClose}
        onSubmit={submit}
        disabled={!name.trim()}
      />
    </Modal>
  );
}

export function NewStoryModal(
  { board, onClose, onCreate }: {
    board: BoardData;
    onClose: () => void;
    onCreate: (o: Record<string, unknown>) => void;
  },
) {
  const [title, setTitle] = useState("");
  const [client, setClient] = useState(board.projects[0]?.name ?? "");
  const [brief, setBrief] = useState("");

  const submit = () => {
    if (!title.trim()) return;
    onCreate({ title: title.trim(), client: client || undefined, brief });
  };

  return (
    <Modal width={720} onClose={onClose} onSubmit={submit}>
      <div className={label}>NEW PROJECT</div>
      <input
        autoFocus
        className={`${input} text-xl font-semibold`}
        placeholder="What are we trying to achieve?"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <div className="w-56">
        <Select
          value={client}
          className={pill}
          options={board.projects.map((c) => ({ value: c.name, label: c.name }))}
          onChange={setClient}
        />
      </div>
      <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-well p-3">
        <textarea
          className={`${input} min-h-[190px] resize-none text-[13px] leading-relaxed`}
          placeholder={STORY_PLACEHOLDER}
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
        />
        <span className="text-[10.5px] text-ink-muted/80">
          The brief — what are we trying to achieve? Sessions ladder up here.
        </span>
      </div>
      <Footer
        hint="projects are also created automatically by /project:track"
        action="Create project"
        onClose={onClose}
        onSubmit={submit}
        disabled={!title.trim()}
      />
    </Modal>
  );
}
