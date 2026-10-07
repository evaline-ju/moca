package exec_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	wexec "github.com/rossoctl/moca/remote-worker/internal/exec"
)

// specRunner records the Spec it was handed and, if block is set, holds the Exec open
// until release is closed — the "a command is running in this workspace" state a sweep
// must not touch.
type specRunner struct {
	mu      sync.Mutex
	got     []wexec.Spec
	started chan struct{}
	release chan struct{}
}

func (r *specRunner) Run(_ context.Context, s wexec.Spec, _ wexec.Sink) (int32, error) {
	r.mu.Lock()
	r.got = append(r.got, s)
	r.mu.Unlock()
	if r.started != nil {
		close(r.started)
	}
	if r.release != nil {
		<-r.release
	}
	return 0, nil
}

type fakeClock struct{ t time.Time }

func (c *fakeClock) now() time.Time { return c.t }

func newWorkspaceRunner(t *testing.T, inner wexec.Runner) (*wexec.WorkspaceRunner, *fakeClock) {
	t.Helper()
	clock := &fakeClock{t: time.Unix(1_700_000_000, 0)}
	return &wexec.WorkspaceRunner{
		Root:  t.TempDir(),
		Idle:  time.Hour,
		Inner: inner,
		Now:   clock.now,
	}, clock
}

func runIn(t *testing.T, w *wexec.WorkspaceRunner, key, cmd string) string {
	t.Helper()
	var rec recorder
	code, err := w.Run(context.Background(), wexec.Spec{Command: cmd, WorkspaceKey: key}, &rec)
	if err != nil || code != 0 {
		t.Fatalf("run %q under key %q: code=%d err=%v stderr=%q", cmd, key, code, err, rec.stderr)
	}
	return strings.TrimSpace(string(rec.stdout))
}

func TestWorkspaceKeysSeeDisjointDirectories(t *testing.T) {
	w, _ := newWorkspaceRunner(t, wexec.BashRunner{})

	if got, want := runIn(t, w, "sess-a", "pwd -P"), mustEval(t, filepath.Join(w.Root, "sess-a")); got != want {
		t.Fatalf("sess-a ran in %q, want %q", got, want)
	}
	runIn(t, w, "sess-a", "echo a > clone.txt")
	if got := runIn(t, w, "sess-b", "ls -A"); got != "" {
		t.Fatalf("sess-b sees %q; want an empty directory of its own", got)
	}
	if got := runIn(t, w, "sess-a", "cat clone.txt"); got != "a" {
		t.Fatalf("sess-a lost its file across Execs: got %q", got)
	}
}

func TestEmptyWorkspaceKeyKeepsTheSharedWorkspace(t *testing.T) {
	inner := &specRunner{}
	w, _ := newWorkspaceRunner(t, inner)
	if _, err := w.Run(context.Background(), wexec.Spec{Command: "true"}, &recorder{}); err != nil {
		t.Fatal(err)
	}
	if got := inner.got[0].Dir; got != "" {
		t.Fatalf("empty key set Dir=%q; want the worker's own cwd, unchanged", got)
	}
	entries, _ := os.ReadDir(w.Root)
	if len(entries) != 0 {
		t.Fatalf("empty key created %d entries under the root", len(entries))
	}
}

func TestInvalidWorkspaceKeyIsRefused(t *testing.T) {
	for _, key := range []string{"a/b", "..", ".", ".hidden", "../escape", "-dash", strings.Repeat("k", 129)} {
		t.Run(key, func(t *testing.T) {
			inner := &specRunner{}
			w, _ := newWorkspaceRunner(t, inner)
			_, err := w.Run(context.Background(), wexec.Spec{Command: "true", WorkspaceKey: key}, &recorder{})
			if err == nil || !strings.HasPrefix(err.Error(), "invalid-workspace-key: ") {
				t.Fatalf("key %q: err=%v, want an invalid-workspace-key refusal", key, err)
			}
			if len(inner.got) != 0 {
				t.Fatalf("key %q reached the inner runner", key)
			}
		})
	}
}

func TestSweepReclaimsOnlyIdleWorkspaces(t *testing.T) {
	w, clock := newWorkspaceRunner(t, wexec.BashRunner{})
	runIn(t, w, "old", "touch f")
	clock.t = clock.t.Add(50 * time.Minute)
	runIn(t, w, "recent", "touch f")
	clock.t = clock.t.Add(20 * time.Minute) // old: 70m idle, recent: 20m

	if got := w.Sweep(); len(got) != 1 || got[0] != "old" {
		t.Fatalf("Sweep reclaimed %v, want [old]", got)
	}
	if _, err := os.Stat(filepath.Join(w.Root, "old")); !os.IsNotExist(err) {
		t.Fatalf("old workspace still present: %v", err)
	}
	if _, err := os.Stat(filepath.Join(w.Root, "recent", "f")); err != nil {
		t.Fatalf("recent workspace was touched: %v", err)
	}
	entries, _ := os.ReadDir(w.Root)
	if len(entries) != 1 {
		t.Fatalf("root holds %d entries after the sweep, want only recent (tombstone left behind?)", len(entries))
	}

	// A reclaimed key that comes back starts over in a fresh, empty directory.
	if got := runIn(t, w, "old", "ls -A"); got != "" {
		t.Fatalf("returning key sees %q, want an empty directory", got)
	}
}

func TestSweepSkipsAWorkspaceWithARunningExec(t *testing.T) {
	inner := &specRunner{started: make(chan struct{}), release: make(chan struct{})}
	w, clock := newWorkspaceRunner(t, inner)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = w.Run(context.Background(), wexec.Spec{Command: "sleep", WorkspaceKey: "busy"}, &recorder{})
	}()
	<-inner.started

	clock.t = clock.t.Add(2 * time.Hour) // started long ago, still running
	if got := w.Sweep(); len(got) != 0 {
		t.Fatalf("Sweep reclaimed %v while an Exec was running", got)
	}
	close(inner.release)
	<-done

	// Idle is measured from the END of the last Exec, not its start.
	if got := w.Sweep(); len(got) != 0 {
		t.Fatalf("Sweep reclaimed %v the instant the Exec finished", got)
	}
	clock.t = clock.t.Add(time.Hour)
	if got := w.Sweep(); len(got) != 1 {
		t.Fatalf("Sweep reclaimed %v an Idle after the Exec finished, want [busy]", got)
	}
}

// mustEval resolves symlinks, since t.TempDir is under /var -> /private/var on macOS and
// `pwd -P` reports the resolved path.
func mustEval(t *testing.T, p string) string {
	t.Helper()
	r, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return r
}
