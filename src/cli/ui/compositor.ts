import * as readline from "node:readline";
import { EventEmitter } from "node:events";

/**
 * TerminalCompositor manages the low-level terminal state and input stream.
 * It ensures that critical shortcuts like Escape and Ctrl+C are always
 * captured, regardless of whether a higher-level UI component (like readline)
 * is currently active or paused.
 */
export class TerminalCompositor extends EventEmitter {
  private static instance: TerminalCompositor | null = null;
  private isRaw = false;
  private activeAbort: (() => void) | null = null;
  private _thinking = false;
  private rl: readline.Interface | null = null;
  private stdinDataHandler: ((chunk: Buffer) => void) | null = null;
  private stdinKeypressHandler: ((str: string, key: any) => void) | null = null;
  private sigintHandler: (() => void) | null = null;

  private constructor() {
    super();
    this.setupInput();
  }

  public static getInstance(): TerminalCompositor {
    if (!TerminalCompositor.instance) {
      TerminalCompositor.instance = new TerminalCompositor();
    }
    return TerminalCompositor.instance;
  }

  public setReadline(rl: readline.Interface) {
    this.rl = rl;
  }

  private setupInput() {
    if (!process.stdin.isTTY) return;

    // Put stdin into raw mode immediately
    try {
      process.stdin.setRawMode(true);
      this.isRaw = true;
    } catch {
      // Fallback for environments where setRawMode might fail
    }

    readline.emitKeypressEvents(process.stdin);

    this.stdinDataHandler = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      
      // Raw Escape (\u001b) or Ctrl+C (\u0003)
      if (text === "\u001b" || text === "\u0003") {
        if (this._thinking && this.activeAbort) {
          this.activeAbort();
          // We don't return here to allow keypress event to be emitted
        }
      }

      this.emit("data", chunk);
    };
    process.stdin.on("data", this.stdinDataHandler);

    this.stdinKeypressHandler = (str: string, key: any) => {
      // Named keys from readline's parser
      if (key?.name === "escape" || (key?.ctrl && key?.name === "c") || key?.sequence === "\u001b" || key?.sequence === "\u0003") {
        if (this._thinking && this.activeAbort) {
          this.activeAbort();
          return;
        }
      }
      this.emit("keypress", str, key);
    };
    process.stdin.on("keypress", this.stdinKeypressHandler);

    // Handle process signals
    this.sigintHandler = () => {
      if (this._thinking && this.activeAbort) {
        this.activeAbort();
      } else if ((this.rl as any)?.__forgeExternalPromptActive || (this.rl as any)?.__forgeModalPromptActive) {
        // Let active prompt UIs handle Ctrl+C/cancel without exiting Forge.
        return;
      } else {
        this.reset();
        process.exit(0);
      }
    };
    process.on("SIGINT", this.sigintHandler);
  }

  /**
   * Enter 'thinking' mode where Esc/Ctrl+C trigger the abort handler.
   */
  public enterThinking(onAbort: () => void) {
    this._thinking = true;
    this.activeAbort = onAbort;
    if (this.rl) {
      this.rl.pause();
    }
    // CRITICAL: rl.pause() internally calls process.stdin.pause(), which stops
    // all 'data' events from flowing. We must resume stdin so our raw ESC/Ctrl+C
    // detection handler keeps receiving key events while readline is paused.
    if (process.stdin.isTTY && process.stdin.isPaused()) {
      process.stdin.resume();
    }
  }

  /**
   * Exit 'thinking' mode.
   */
  public exitThinking() {
    this._thinking = false;
    this.activeAbort = null;
    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
        this.isRaw = true;
      } catch {
        // ignore terminal restoration failures
      }
      if (process.stdin.isPaused()) {
        try {
          process.stdin.resume();
        } catch {
          // ignore
        }
      }
    }
    if (this.rl) {
      this.rl.resume();
    }
  }

  public reset() {
    if (this.stdinDataHandler) {
      try {
        process.stdin.off("data", this.stdinDataHandler);
      } catch {
        // ignore
      }
      this.stdinDataHandler = null;
    }
    if (this.stdinKeypressHandler) {
      try {
        process.stdin.off("keypress", this.stdinKeypressHandler);
      } catch {
        // ignore
      }
      this.stdinKeypressHandler = null;
    }
    if (this.sigintHandler) {
      try {
        process.off("SIGINT", this.sigintHandler);
      } catch {
        // ignore
      }
      this.sigintHandler = null;
    }
    if (this.isRaw && process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
        this.isRaw = false;
      } catch {
        // Ignore
      }
    }
    this.removeAllListeners();
  }
}
