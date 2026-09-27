import { Box, Text, useInput, type Key } from 'ink';
import { useRef, useState } from 'react';
import { useTheme } from '../theme/context.js';

// ink's useInput doc: "if the user pastes text and it's more than one character, the callback
// will be called only once, and the whole string will be passed as input" -- with every key.*
// flag false, since the combined chunk doesn't match any single named key. Fast typing (not just
// an explicit paste) can trigger the exact same delivery whenever the OS/tty/multiplexer buffers a
// character together with the very next one, most dangerously the following Enter: a `\r` glued
// onto the end of an otherwise-normal `input` string renders as nothing, so the field APPEARS
// unchanged and the caller sees no submit — indistinguishable from nothing having happened. A
// confused Backspace then removes that invisible `\r` first (still no visible change), and only
// the SECOND Backspace removes the character the user actually meant to delete, so a fast
// "litellm<Enter>" can end up stored as "litell". NO_KEY / CONTROL_KEYS below let the callback
// detect this shape and replay it byte-by-byte through the same per-key logic, so each control
// byte does what it would have done had it arrived alone. Deliberately narrow: only the
// single-byte controls this form's own handler reacts to (Return, Tab, Backspace/Delete, a bare
// Escape) are decoded -- multi-byte sequences (arrow keys) landing mid-burst are a much rarer
// shape for typing text into a field, and correctly splitting arbitrary ANSI escapes out of a raw
// byte run is a full terminal-input parser, not a targeted fix for the failure seen in practice.
const NO_KEY: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const CONTROL_KEYS: Record<string, Partial<Key>> = {
  '\r': { return: true },
  '\n': { return: true },
  '\t': { tab: true },
  '\x7f': { backspace: true },
  '\x08': { backspace: true },
  '\x1b': { escape: true },
};
const hasAnyFlag = (key: Key): boolean => Object.values(key).some((v) => v === true);

export interface FormField {
  key: string;
  label: string;
  masked?: boolean;
  hint?: string;
  initial?: string;
  optional?: boolean;
  suggestions?: string[];
  visible?: (values: Record<string, string>) => boolean;
}

interface Props {
  title: string;
  fields: FormField[];
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
  validate?: (values: Record<string, string>) => string | undefined;
  error?: string;
}

export function Form({ title, fields, onSubmit, onCancel, validate, error }: Props) {
  const { tokens: t } = useTheme();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, f.initial ?? ''])),
  );
  const [focus, setFocus] = useState(0);
  const [problem, setProblem] = useState<string>();

  // A burst of keystrokes delivered before React re-renders (key repeat, a pasted "\n") invokes
  // this same useInput closure several times with no render in between, so reading `values` /
  // `focus` state (this render's snapshot) would make every call in the burst see the *same*
  // snapshot — e.g. two Enters on the last field would both read "not yet submitted" and both
  // call onSubmit. `values`/`focus` are mirrored into refs that are mutated synchronously
  // alongside every state update; the handler derives `shown`/`at`/`field` from the refs (so
  // each keystroke sees the previous keystroke's effect), while the JSX below still renders
  // from state, which catches up once React flushes.
  const valuesRef = useRef(values);
  const focusRef = useRef(focus);
  // Guards a repeated Enter on an already-submitted last field from calling onSubmit twice.
  // Cleared on the next value change, so fixing a validation error and resubmitting still
  // works; a fresh mount of the form also starts unblocked.
  const submittedRef = useRef(false);

  const shownOf = (vals: Record<string, string>) =>
    fields.filter((f) => !f.visible || f.visible(vals));

  const setFieldValue = (key: string, next: string) => {
    valuesRef.current = { ...valuesRef.current, [key]: next };
    submittedRef.current = false;
    setValues(valuesRef.current);
  };

  const setFocusNow = (next: number) => {
    focusRef.current = next;
    setFocus(next);
  };

  const submit = (vals: Record<string, string>, shownFields: FormField[]) => {
    const out = Object.fromEntries(shownFields.map((f) => [f.key, vals[f.key] ?? '']));
    const missing = shownFields.find((f) => !f.optional && !out[f.key].trim());
    if (missing) return setProblem(`${missing.label} is required`);
    const msg = validate?.(out);
    if (msg) return setProblem(msg);
    setProblem(undefined);
    submittedRef.current = true;
    onSubmit(out);
  };

  const shown = shownOf(values);
  const at = Math.min(focus, shown.length - 1);

  const handleKey = (input: string, key: Key) => {
    const valuesNow = valuesRef.current;
    const shownNow = shownOf(valuesNow);
    const atNow = Math.min(focusRef.current, shownNow.length - 1);
    const fieldNow = shownNow[atNow];
    if (!fieldNow) return;
    if (key.escape) return onCancel();
    if (key.upArrow) return setFocusNow(Math.max(0, atNow - 1));
    if (key.downArrow) return setFocusNow(Math.min(shownNow.length - 1, atNow + 1));
    if (key.return) {
      if (atNow === shownNow.length - 1) {
        if (!submittedRef.current) submit(valuesNow, shownNow);
      } else setFocusNow(atNow + 1);
      return;
    }
    if (key.tab) {
      const s = fieldNow.suggestions;
      if (s && s.length > 0) {
        const next = s[(s.indexOf(valuesNow[fieldNow.key]) + 1) % s.length];
        setFieldValue(fieldNow.key, next);
      } else setFocusNow(Math.min(shownNow.length - 1, atNow + 1));
      return;
    }
    if (key.backspace || key.delete) {
      setFieldValue(fieldNow.key, (valuesNow[fieldNow.key] ?? '').slice(0, -1));
      return;
    }
    if (input && !key.ctrl && !key.meta)
      setFieldValue(fieldNow.key, (valuesNow[fieldNow.key] ?? '') + input);
  };

  useInput((input, key) => {
    if (!hasAnyFlag(key) && input.length > 1 && /[\r\n\t\x7f\x08\x1b]/.test(input)) {
      for (const ch of input) {
        const mapped = CONTROL_KEYS[ch];
        handleKey(mapped ? '' : ch, mapped ? { ...NO_KEY, ...mapped } : NO_KEY);
      }
      return;
    }
    handleKey(input, key);
  });

  return (
    <Box flexDirection="column">
      <Text bold color={t.primary}>
        {title}
      </Text>
      {shown.map((f, i) => {
        const v = values[f.key] ?? '';
        const display = f.masked ? '•'.repeat(Array.from(v).length) : v;
        return (
          <Box key={f.key} flexDirection="column">
            <Text color={i === at ? t.primary : t.text}>
              {i === at ? '› ' : '  '}
              {f.label}: {display}
              {i === at ? '▌' : ''}
            </Text>
            {i === at && f.hint ? <Text color={t.muted}> {f.hint}</Text> : null}
            {i === at && f.suggestions ? (
              <Text color={t.muted}> tab: {f.suggestions.join(' / ')}</Text>
            ) : null}
          </Box>
        );
      })}
      {problem ? <Text color={t.warning}>{problem}</Text> : null}
      {error ? <Text color={t.error}>{error}</Text> : null}
    </Box>
  );
}
