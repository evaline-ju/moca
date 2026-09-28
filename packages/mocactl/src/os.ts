import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Paths } from './config.js';

export interface OsDeps {
  copy(text: string): Promise<void>;
  openUrl(url: string): void;
  editText(initial: string): string;
  openInEditor(file: string): void;
}

export function editorCommand(env: NodeJS.ProcessEnv): string {
  return env.VISUAL || env.EDITOR || 'vi';
}

/** The URL to hand the platform opener, or undefined unless it is plain http(s). */
export function openableUrl(url: string): string | undefined {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

// The URL comes from the server (the device flow's verificationUri): anything but http(s) — a
// file: path, a custom scheme handler, a bare word `open` would treat as a file — is not opened.
export function openCommand(
  platform: NodeJS.Platform,
  raw: string,
): { cmd: string; args: string[] } | undefined {
  const url = openableUrl(raw);
  if (!url) return undefined;
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  return { cmd: 'xdg-open', args: [url] };
}

/**
 * Splits `$VISUAL`/`$EDITOR` into words the way a POSIX shell would for the common cases —
 * whitespace separates, '…' is literal, "…" is literal except for \" and \\, and a backslash
 * outside quotes escapes the next character — so `code --wait` and
 * `"/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl" -w` both work. No expansion
 * of any kind happens: `$VAR`, backticks, globs and `#` are ordinary characters.
 */
export function editorArgv(command: string): string[] {
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === '\\' && (command[i + 1] === '"' || command[i + 1] === '\\'))
        word += command[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote) throw new Error(`could not start editor "${command}": unterminated ${quote} quote`);
  if (inWord) words.push(word);
  if (words.length === 0) throw new Error('could not start editor: $EDITOR is blank');
  return words;
}

// The editor runs WITHOUT a shell: `$VISUAL`/`$EDITOR` is split into words (editorArgv) and the
// file is appended as one more argument. So neither the editor string nor the file path — which
// can hold spaces, `$` or backticks — is ever interpreted by a shell. The price is that an editor
// string relying on shell expansion (`$HOME/bin/ed`) must be written out; on Windows it must name
// an executable (a `.cmd` shim such as `code` needs its full `Code.exe` path), since Node refuses
// to run a batch file without a shell.
//
// A missing or unstartable editor must not be silently swallowed: editText must not return the
// caller's untouched initial text as though the user had saved something. spawnSync never throws
// on its own, so its result is inspected here:
//  - `result.error` means the editor could not be started at all (e.g. ENOENT: not found).
//  - `result.signal` means it was killed outright by a signal.
// An ordinary non-zero exit status is NOT an error (e.g. vim can exit 1 benignly) and is left
// alone.
function runEditor(env: NodeJS.ProcessEnv, file: string): void {
  const editor = editorCommand(env);
  const [cmd, ...args] = editorArgv(editor);
  const result = spawnSync(cmd!, [...args, file], { stdio: 'inherit' });
  if (result.error) {
    throw new Error(`could not start editor "${editor}": ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`editor "${editor}" was killed by signal ${result.signal}`);
  }
}

export function realOs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): OsDeps {
  return {
    async copy(text) {
      const { default: clipboard } = await import('clipboardy');
      await clipboard.write(text);
    },
    openUrl(url) {
      const command = openCommand(platform, url);
      if (!command) return;
      const { cmd, args } = command;
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => undefined);
      child.unref();
    },
    editText(initial) {
      const dir = mkdtempSync(join(tmpdir(), 'mocactl-edit-'));
      const file = join(dir, 'prompt.md');
      try {
        writeFileSync(file, initial, { mode: 0o600 });
        runEditor(env, file);
        return readFileSync(file, 'utf8').replace(/\n$/, '');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    openInEditor(file) {
      runEditor(env, file);
    },
  };
}

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

export function writeExport(paths: Paths, sessionId: string, markdown: string): string {
  if (!SAFE_ID.test(sessionId)) throw new Error(`refusing unsafe session id: ${sessionId}`);
  mkdirSync(paths.exportsDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.exportsDir, 0o700);
  const file = join(paths.exportsDir, `${sessionId}.md`);
  writeFileSync(file, markdown, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}
