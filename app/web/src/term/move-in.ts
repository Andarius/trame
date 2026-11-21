import { appConfirm } from "../ui/ui";
import { moveIntoTrame, TermError } from "./term-api";

// moves a Claude session from another terminal into a Trame tab, asking first when it is mid-turn
export async function moveIn(opts: { session: string; card: string | null; title: string }) {
  try {
    return await moveIntoTrame(opts);
  } catch (e) {
    if (!(e instanceof TermError && e.info.code === "busy")) throw e;
    const ok = await appConfirm("It is in the middle of a turn. Stop it in the other terminal and resume it here?", "Move");
    return ok ? await moveIntoTrame({ ...opts, force: true }) : null;
  }
}
