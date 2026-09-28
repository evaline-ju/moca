import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { Form, type FormField } from '../src/views/Form.js';
import { KEY, inputReady, tick, waitFor, withTheme } from './helpers/ink.js';

const fields: FormField[] = [
  { key: 'name', label: 'Name' },
  { key: 'kind', label: 'Kind', initial: 'bearer', suggestions: ['bearer', 'api-key'] },
  { key: 'token', label: 'Token', masked: true },
];

async function type(stdin: { write: (s: string) => void }, ...chunks: string[]) {
  for (const c of chunks) {
    stdin.write(c);
    await tick();
  }
}

describe('Form', () => {
  it('walks the fields with Enter and submits on the last', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      withTheme(<Form title="Add" fields={fields} onSubmit={onSubmit} onCancel={vi.fn()} />),
    );
    await type(stdin, 'anthropic', KEY.enter, KEY.enter, 'sk-test', KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith({ name: 'anthropic', kind: 'bearer', token: 'sk-test' }); // notsecret
  });

  it('submits the full value when Enter arrives glued to the text in one stdin chunk', async () => {
    // ink's own useInput doc: "if the user pastes text and it's more than one character, the
    // callback will be called only once, and the whole string will be passed as input" -- with
    // every key.* flag false, since the combined chunk doesn't match any single named key. Fast
    // typing (or a paste, or tty/multiplexer buffering) can deliver a final character glued to the
    // following Enter the exact same way. Before the fix, that Enter is silently swallowed as part
    // of a literal `\r` appended to the field's text: the field never advances (no visible sign
    // anything went wrong -- \r renders as nothing), and a confused Backspace removes the invisible
    // \r first, then the intended last character -- which is how "litellm<Enter>" typed fast can
    // end up stored as "litell".
    const onSubmit = vi.fn();
    const { stdin } = render(
      withTheme(<Form title="Add" fields={[fields[0]]} onSubmit={onSubmit} onCancel={vi.fn()} />),
    );
    await waitFor(() => inputReady(stdin));
    stdin.write('litellm\r');
    await tick();
    expect(onSubmit).toHaveBeenCalledWith({ name: 'litellm' });
  });

  it('masks secret input', async () => {
    const { stdin, lastFrame } = render(
      withTheme(<Form title="Add" fields={[fields[2]]} onSubmit={vi.fn()} onCancel={vi.fn()} />),
    );
    await type(stdin, 'abc');
    expect(lastFrame()).toContain('•••');
    expect(lastFrame()).not.toContain('abc');
  });

  it('cycles suggestions with Tab', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      withTheme(<Form title="Add" fields={[fields[1]]} onSubmit={onSubmit} onCancel={vi.fn()} />),
    );
    await type(stdin, KEY.tab, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith({ kind: 'api-key' });
  });

  it('refuses to submit a required empty field', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      withTheme(<Form title="Add" fields={[fields[0]]} onSubmit={onSubmit} onCancel={vi.fn()} />),
    );
    await type(stdin, KEY.enter);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('Name is required');
  });

  it('shows a validate message instead of submitting', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      withTheme(
        <Form
          title="Add"
          fields={[fields[0]]}
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          validate={(v) => (v.name === 'BAD' ? 'lower-case only' : undefined)}
        />,
      ),
    );
    await type(stdin, 'BAD', KEY.enter);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('lower-case only');
  });

  it('shows a server error under the form', () => {
    const { lastFrame } = render(
      withTheme(
        <Form
          title="Add"
          fields={fields}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
          error="kind 'basic' requires secret fields: password, username"
        />,
      ),
    );
    expect(lastFrame()).toContain('requires secret fields');
  });

  it('skips fields that are not visible', async () => {
    const onSubmit = vi.fn();
    const f: FormField[] = [
      { key: 'consumer', label: 'Consumer', initial: 'sandbox-egress' },
      { key: 'endpoint', label: 'Endpoint', visible: (v) => v.consumer === 'inference' },
    ];
    const { stdin, lastFrame } = render(
      withTheme(<Form title="Add" fields={f} onSubmit={onSubmit} onCancel={vi.fn()} />),
    );
    expect(lastFrame()).not.toContain('Endpoint');
    await type(stdin, KEY.enter);
    expect(onSubmit).toHaveBeenCalledWith({ consumer: 'sandbox-egress' });
  });

  it('calls onSubmit exactly once for a burst of two Enters on the last field', async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      withTheme(<Form title="Add" fields={[fields[0]]} onSubmit={onSubmit} onCancel={vi.fn()} />),
    );
    await type(stdin, 'anthropic');
    stdin.write(KEY.enter);
    stdin.write(KEY.enter);
    await tick();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith({ name: 'anthropic' });
  });

  it('advances focus twice for a burst of two Enters mid-form', async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      withTheme(<Form title="Add" fields={fields} onSubmit={onSubmit} onCancel={vi.fn()} />),
    );
    await type(stdin, 'anthropic');
    stdin.write(KEY.enter);
    stdin.write(KEY.enter);
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('› Token');
  });

  it('cycles suggestions twice for a burst of two Tabs', async () => {
    const onSubmit = vi.fn();
    const f: FormField[] = [
      { key: 'kind', label: 'Kind', initial: 'a', suggestions: ['a', 'b', 'c'] },
    ];
    const { stdin } = render(
      withTheme(<Form title="Add" fields={f} onSubmit={onSubmit} onCancel={vi.fn()} />),
    );
    stdin.write(KEY.tab);
    stdin.write(KEY.tab);
    await tick();
    stdin.write(KEY.enter);
    await tick();
    expect(onSubmit).toHaveBeenCalledWith({ kind: 'c' });
  });

  it('cancels with Esc', async () => {
    const onCancel = vi.fn();
    const { stdin } = render(
      withTheme(<Form title="Add" fields={fields} onSubmit={vi.fn()} onCancel={onCancel} />),
    );
    stdin.write(KEY.escape);
    await tick(80);
    expect(onCancel).toHaveBeenCalled();
  });
});
