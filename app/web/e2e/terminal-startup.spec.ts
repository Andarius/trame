import { expect, test } from "@playwright/test";

test("terminal answers the mode query used at Codex startup and continues rendering", async ({ page }) => {
  const id = "test-terminal";
  const responses: Record<string, unknown> = {
    "/api/term/token": { token: "test-token" },
    "/api/term/sessions": [],
  };
  await page.route("**/api/term/**", (route) =>
    route.fulfill({ json: responses[new URL(route.request().url()).pathname] ?? null }));

  const replies: string[] = [];
  await page.routeWebSocket(`**/api/term/${id}/ws`, (ws) => {
    ws.onMessage((message) => {
      if (typeof message !== "string") {
        replies.push(message.toString());
      } else if (JSON.parse(message).type === "auth") {
        ws.send(JSON.stringify({ type: "attach", offset: 0, reset: false }));
        ws.send(Buffer.from("\x1b[?1007$p\r\nterminal output after query"));
      }
    });
  });

  await page.goto(`/?popout=${id}`);
  await expect.poll(() => replies).toContain("\x1b[?1007;0$y");
  await expect(page.getByText("terminal output after query", { exact: true })).toBeVisible();
});
