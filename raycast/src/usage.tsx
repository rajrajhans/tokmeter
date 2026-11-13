import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { useEffect, useState } from "react";
import { Action, ActionPanel, Color, Detail, Icon, List, environment, openExtensionPreferences } from "@raycast/api";
import { accountStatus, dashboardAlt, layoutBoard } from "./lib/chart";
import { accountMarkdown, weeklyFirst, type UsageView } from "./lib/model";
import { useQuotas } from "./use-quotas";

export default function Command() {
  const { isLoading, view, failure, revalidate } = useQuotas();
  const theme = environment.appearance === "light" ? "light" : "dark";
  const board = useBoard(view, failure, theme);
  const actions = <BoardActions view={view} failure={failure} refreshing={isLoading || board.pending} onRefresh={() => { if (!isLoading) revalidate(); }} />;

  return (
    <Detail
      // Keep Raycast’s loading shimmer off during background refreshes.
      isLoading={!board.path && (isLoading || board.pending)}
      navigationTitle="tokmeter"
      markdown={board.path
        ? `![${board.alt}](${fileUrl(board.path)}?raycast-width=720&raycast-height=${board.height})`
        : board.error ? `Couldn't draw the dashboard.\n\n${board.error}\n\nOpen Account Details with ⌘D.` : ""}
      actions={actions}
    />
  );
}

type BoardState = { signature: string; path?: string; height?: number; alt?: string; error?: string };
function useBoard(view: UsageView | undefined, failure: string | undefined, theme: "light" | "dark") {
  const signature = JSON.stringify({ theme, failure, view });
  const [state, setState] = useState<BoardState>({ signature: "" });

  useEffect(() => {
    if (!view && !failure) return;
    let cancelled = false;
    const spec = layoutBoard(view, { failure, theme });
    const json = JSON.stringify(spec);
    const hash = createHash("sha1").update(json).digest("hex").slice(0, 16);
    const dir = join(environment.supportPath, "boards");
    const png = join(dir, `${hash}.png`);
    const alt = dashboardAlt(view, failure);
    const finish = (next: { path?: string; error?: string }) => {
      if (!cancelled) setState(previous => ({
        ...previous, signature, ...next,
        // Swap image, dimensions and alt text atomically to avoid flicker.
        ...(next.path ? { height: spec.height, alt, error: undefined } : {}),
      }));
    };
    try {
      mkdirSync(dir, { recursive: true });
      if (existsSync(png)) {
        finish({ path: png });
        return () => { cancelled = true; };
      }
      const specPath = join(dir, `${hash}.json`);
      writeFileSync(specPath, json);
      execFile("osascript", ["-l", "JavaScript", join(environment.assetsPath, "draw.js"), specPath, png], { timeout: 15000 }, error => {
        try { unlinkSync(specPath); } catch { /* already removed */ }
        if (cancelled) return;
        if (error) { finish({ error: error.message }); return; }
        finish({ path: png });
        // Retain the displayed image until Raycast finishes the swap.
        try {
          const old = readdirSync(dir).filter(name => name.endsWith(".png"))
            .map(name => ({ path: join(dir, name), time: statSync(join(dir, name)).mtimeMs }))
            .sort((a, b) => b.time - a.time).slice(8);
          for (const file of old) if (file.path !== png && file.path !== state.path) {
            try { unlinkSync(file.path); } catch { /* another render owns it */ }
          }
        } catch { /* cache cleanup must never replace a successful render */ }
      });
    } catch (error) {
      finish({ error: error instanceof Error ? error.message : "Rendering failed" });
    }
    return () => { cancelled = true; };
    // Capture the prior image without retriggering the effect when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return { ...state, pending: state.signature !== signature };
}

function fileUrl(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

function BoardActions(props: { view?: UsageView; failure?: string; refreshing: boolean; onRefresh: () => void }) {
  return (
    <ActionPanel>
      <Action title={props.refreshing ? "Refreshing…" : "Refresh"} icon={Icon.ArrowClockwise}
        shortcut={{ modifiers: ["cmd"], key: "r" }} onAction={props.onRefresh} />
      {props.view ? <Action.Push title="Account Details" icon={Icon.List}
        shortcut={{ modifiers: ["cmd"], key: "d" }} target={<AccountDetails view={props.view} />} /> : null}
      {props.view?.summary ? <Action.CopyToClipboard title="Copy Summary" content={props.view.summary} /> : null}
      {props.failure ? <Action.Push title="Refresh Diagnostics" icon={Icon.ExclamationMark} target={<Detail markdown={props.failure} />} /> : null}
      <Action title="Extension Preferences" icon={Icon.Gear} shortcut={{ modifiers: ["cmd", "shift"], key: "," }} onAction={() => void openExtensionPreferences()} />
    </ActionPanel>
  );
}

function AccountDetails({ view }: { view: UsageView }) {
  return (
    <List isShowingDetail navigationTitle="Account Details" searchBarPlaceholder="Find an account, quota, or activity…">
      {view.accounts.map(account => {
        const status = accountStatus(account);
        const rows = weeklyFirst(account.rows).filter(row => row.icon !== "person");
        return (
          <List.Item key={account.key} title={account.providerName} subtitle={account.shortLabel}
            keywords={account.keywords}
            icon={{ source: status?.unavailable ? Icon.ExclamationMark : Icon.BarChart, tintColor: status ? Color.Yellow : Color.SecondaryText }}
            detail={<List.Item.Detail markdown={accountMarkdown(account)} />}
            actions={<ActionPanel><Action.CopyToClipboard title="Copy Account Summary" content={rows.map(r => r.copyLine).join("\n")} /></ActionPanel>} />
        );
      })}
    </List>
  );
}
