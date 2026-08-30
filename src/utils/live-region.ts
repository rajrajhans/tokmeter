/**
 * A block of terminal output that can be rewritten in place.
 *
 * Repaint is "cursor up N, erase to end of screen, write again". N has to
 * count the rows the terminal *soft-wrapped* the text into, not the newlines
 * we wrote — otherwise every repaint walks a little further up the scrollback
 * and smears the previous frame over whatever was above it.
 */

const ESC = "\x1b";

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

function visibleWidth(line: string): number {
  return line.replace(ANSI_RE, "").length;
}

export class LiveRegion {
  private rows = 0;
  private cursorHidden = false;
  private readonly stream: NodeJS.WriteStream;

  constructor(stream: NodeJS.WriteStream = process.stdout) {
    this.stream = stream;
  }

  private get columns(): number {
    const c = this.stream.columns;
    return typeof c === "number" && c > 0 ? c : 80;
  }

  private get viewportRows(): number {
    const r = this.stream.rows;
    return typeof r === "number" && r > 0 ? r : 24;
  }

  private rowsFor(text: string): number {
    const cols = this.columns;
    let total = 0;
    for (const line of text.split("\n")) {
      const w = visibleWidth(line);
      total += w === 0 ? 1 : Math.ceil(w / cols);
    }
    return total;
  }

  /**
   * Keep live repainting safe when the full view is taller than the terminal.
   * The tail contains the providers that are still settling (normally the slow
   * one), while the complete, uncut view is still printed by `finish()`.
   */
  private fitToViewport(text: string): string {
    const maxRows = Math.max(1, this.viewportRows - 1);
    if (this.rowsFor(text) <= maxRows) return text;

    const lines = text.split("\n");
    const kept: string[] = [];
    // Reserve one visual row for the omitted-content marker.
    let usedRows = 1;
    let firstKept = lines.length;

    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const lineRows = this.rowsFor(lines[i]!);
      if (usedRows + lineRows > maxRows) break;
      kept.unshift(lines[i]!);
      usedRows += lineRows;
      firstKept = i;
    }

    // A crop boundary can land on the separator at the end of a provider box.
    // Do not leave that orphaned connector directly under the marker.
    while (kept[0]?.replace(ANSI_RE, "").trim() === "│") {
      kept.shift();
      firstKept += 1;
    }

    return [`… ${firstKept} lines above`, ...kept].join("\n");
  }

  private erase(): void {
    if (this.rows > 0) this.stream.write(`${ESC}[${this.rows}A`);
    this.stream.write(`${ESC}[0J`);
    this.rows = 0;
  }

  private hideCursor(): void {
    if (this.cursorHidden) return;
    this.cursorHidden = true;
    this.stream.write(`${ESC}[?25l`);
  }

  private showCursor(): void {
    if (!this.cursorHidden) return;
    this.cursorHidden = false;
    this.stream.write(`${ESC}[?25h`);
  }

  private writeBlock(text: string): void {
    this.stream.write(text.endsWith("\n") ? text : `${text}\n`);
  }

  /** Redraw the region with `text`, clipping tall intermediate views safely. */
  update(text: string): void {
    const fitted = this.fitToViewport(text);
    const next = this.rowsFor(fitted);
    this.hideCursor();
    this.erase();
    this.writeBlock(fitted);
    this.rows = next;
  }

  /** Replace the region with its final content and hand the cursor back. */
  finish(text: string): void {
    this.erase();
    this.writeBlock(text);
    this.rows = 0;
    this.showCursor();
  }

  /** Tear the region down without printing anything (Ctrl-C). */
  abort(): void {
    this.erase();
    this.showCursor();
  }
}
