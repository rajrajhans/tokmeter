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
  private disabled = false;
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

  /** Redraw the region with `text`. No-op once the region has been disabled. */
  update(text: string): void {
    if (this.disabled) return;
    const next = this.rowsFor(text);
    if (next >= this.viewportRows) {
      // Taller than the window: the terminal would scroll and invalidate the
      // cursor-up count. Drop back to printing once, at the end.
      this.erase();
      this.showCursor();
      this.disabled = true;
      return;
    }
    this.hideCursor();
    this.erase();
    this.writeBlock(text);
    this.rows = next;
  }

  /** Replace the region with its final content and hand the cursor back. */
  finish(text: string): void {
    if (!this.disabled) this.erase();
    this.writeBlock(text);
    this.rows = 0;
    this.showCursor();
  }

  /** Tear the region down without printing anything (Ctrl-C). */
  abort(): void {
    if (!this.disabled) this.erase();
    this.showCursor();
  }
}
