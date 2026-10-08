package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// #368: the demo's research turn runs `curl` and `git` in this sandbox, and `git config --global`
// needs a writable HOME. None of that is in `probed` (curl is not an advertised capability), so the
// capability test above does not cover it. This does, statically and against INSTRUCTIONS only, for
// the same reasons dockerfile_parity_test.go explains at length.
var (
	homeInstall = regexp.MustCompile(`(?m)^RUN install -d ((?:-[ogm] \S+ +)+)/home/sandbox\s*$`)
	envHome     = regexp.MustCompile(`(?m)^ENV HOME=/home/sandbox\s*$`)
)

// #415: the system gitconfig. `git` is in `probed`, so dockerfile_parity_test.go proves the binary
// is installed -- but an installed git with no identity still fails an agent's FIRST `git commit`
// with exit 128, which is a tool call wasted on a workaround the image could have shipped. The
// exact RUN instruction, not a loose substring: `user.name`/`user.email` appearing in comment
// prose (exactly what bit the earlier revisions of dockerfile_parity_test.go) must not satisfy
// this. The value is pinned, not just any name/email, because a deliberately non-deliverable
// .invalid address and an obviously-synthetic name are what keep an automated commit made in a
// sandbox identifiable as such.
var systemGitconfig = regexp.MustCompile(
	`(?m)^RUN printf '\[user\]\\n\\tname = MOCA sandbox\\n\\temail = sandbox@moca\.invalid\\n' > /etc/gitconfig\s*$`)

// systemGitconfigPrintf captures the printf FORMAT STRING itself (group 1), so the runtime
// content check below can decode it the way a shell would: printf's format escapes
// (\n, \t) become real newlines/tabs. The literal \\n in the Go regex matches the Dockerfile's
// backslash-n text, and the replacement below re-expands it, so what lands in the scratch
// gitconfig is byte-for-byte what the image's /etc/gitconfig would hold.
var systemGitconfigPrintf = regexp.MustCompile(
	`(?m)^RUN printf '([^']*)' > /etc/gitconfig\s*$`)

// Installed explicitly, not inherited from ubi-minimal: an inherited package is one base-image
// rebuild away from vanishing, and curl-minimal (not curl, which conflicts with it on UBI 9) is what
// the base ships.
var researchPackages = []string{"curl-minimal", "ca-certificates"}

func TestBothDockerfilesInstallResearchTooling(t *testing.T) {
	for name, body := range dockerfiles(t) {
		pkgs := runtimePackages(t, name, body)
		for _, p := range researchPackages {
			if !slices.Contains(pkgs, p) {
				t.Errorf("%s does not install %q explicitly (runtime install list: %v). The sandbox "+
					"research turn fetches over HTTPS with curl, and an inherited package is one base "+
					"rebuild from gone.", name, p, pkgs)
			}
		}
	}
}

func TestBothDockerfilesGiveTheSandboxAWritableHome(t *testing.T) {
	for name, body := range dockerfiles(t) {
		body := code(body)
		m := homeInstall.FindStringSubmatch(body)
		if m == nil {
			t.Errorf("%s: no `RUN install -d ... /home/sandbox`. Without it HOME is unwritable and "+
				"`git config --global` fails inside the sandbox.", name)
		} else {
			ws := workspaceInstall.FindStringSubmatch(body)
			// Same owner/group/mode as /workspace: that is what makes it writable for uid 1001 AND for
			// an arbitrary gid-0 uid under nonroot-v2.
			if ws != nil && canonicalInstallFlags(t, name, m[1]) != canonicalInstallFlags(t, name, ws[1]) {
				t.Errorf("%s: /home/sandbox is created with different owner/group/mode from "+
					"/workspace (%q vs %q)", name, m[1], ws[1])
			}
		}
		if !envHome.MatchString(body) {
			t.Errorf("%s: no `ENV HOME=/home/sandbox`. HOME then depends on the runtime: podman "+
				"uses the WORKDIR (the shared /workspace), Docker and containerd use /.", name)
		}
	}
}

// #415: an installed git (dockerfile_parity_test.go's job) plus a writable HOME (#372, above) is
// still not a commit-capable git -- without any identity the first `git commit` fails with
// exit 128, which is the exact failure observed on the VM demo's live run. A SYSTEM gitconfig
// is the only placement that covers every uid the image can run as, and it must come BEFORE
// `USER 1001`: writing /etc requires root, and the parity test above pins that the runtime
// stage ends with exactly one USER.
func TestBothDockerfilesBakeASystemGitIdentity(t *testing.T) {
	for name, body := range dockerfiles(t) {
		body := code(body)
		m := systemGitconfig.FindStringIndex(body)
		if m == nil {
			t.Errorf("%s: no RUN instruction writing /etc/gitconfig with user.name/user.email. "+
				"Without it an agent's first `git commit` fails with exit 128 (\"Please tell me "+
				"who you are\"), costing a tool call and a model round on a workaround -- "+
				"observed live on the VM demo (#415).", name)
			continue
		}
		if userAt := strings.Index(body, "USER 1001"); userAt >= 0 && m[1] > userAt {
			t.Errorf("%s: the /etc/gitconfig RUN sits after `USER 1001` -- /etc is root-owned, "+
				"so the build fails (or the file is silently absent) depending on the builder. "+
				"Move it before the USER drop.", name)
		}
	}
}

// TestTheBakedGitIdentitySatisfiesACommit proves the CONTENT of that printf line, not just
// its presence: the exact bytes the Dockerfiles write are extracted, installed as a scratch
// environment's SYSTEM config (GIT_CONFIG_SYSTEM, the same precedence slot /etc/gitconfig
// occupies in the image -- needs git >= 2.32, older git ignores the variable), and a real
// `git commit` is run in a throwaway repo with NO other config of any kind -- the same
// first-commit-no-prior-config situation an agent hits. The static test above catches the
// line's deletion; this catches the subtler drift of a line that still prints A gitconfig,
// just one git silently ignores (a typo'd section header, a missing key, an escaped \t that
// landed literally). Two guards keep it honest about that: the commit runs with
// user.useConfigOnly (so an unconfigured git cannot fall back to an auto-guessed identity
// and pass anyway), and the resulting commit's author is asserted to BE the baked one, not
// just any. Needs only git on PATH (the tool these images exist to provide); skips rather
// than fails when the host lacks it, because a CI runner without git is not an image defect.
func TestTheBakedGitIdentitySatisfiesACommit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH; the content check needs it")
	}
	files := dockerfiles(t)
	// The two files must agree, or the image an operator gets depends on the build path.
	var contents []string
	for _, name := range []string{"Dockerfile", "Dockerfile.runtime"} {
		m := systemGitconfigPrintf.FindStringSubmatch(code(files[name]))
		if m == nil {
			t.Fatalf("%s: cannot extract the gitconfig printf (the static test above should "+
				"have flagged this first)", name)
		}
		// printf's format string: \n and \t are written literally in the Dockerfile and
		// expanded by printf at build time. Expand them here the same way, so the scratch
		// gitconfig holds the bytes the image's /etc/gitconfig holds. A shell `printf %b`
		// would do this exactly; Go's strings are already unescaped literals, so the manual
		// replacement below is the same expansion with no shell involved.
		contents = append(contents, strings.NewReplacer(`\n`, "\n", `\t`, "\t").Replace(m[1]))
	}
	if contents[0] != contents[1] {
		t.Fatalf("the two leaf Dockerfiles bake different gitconfigs:\n  Dockerfile:         %q\n  Dockerfile.runtime: %q",
			contents[0], contents[1])
	}
	gitconfig := contents[0]

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "gitconfig"), []byte(gitconfig), 0o644); err != nil {
		t.Fatalf("write scratch gitconfig: %v", err)
	}
	// A repo the command runs in; not under HOME, so no global config can leak in.
	repo := filepath.Join(dir, "repo")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatalf("mkdir scratch repo: %v", err)
	}
	run := func(args ...string) ([]byte, error) {
		cmd := exec.Command("git", args...)
		cmd.Dir = repo
		cmd.Env = []string{
			// ONLY the system slot points anywhere: the baked /etc/gitconfig content, and
			// nothing else. HOME points at an empty dir so a host ~/.gitconfig cannot
			// satisfy the commit for the image (which would make this test pass vacuously),
			// and the global slot is explicitly severed too, belt and braces.
			"GIT_CONFIG_SYSTEM=" + filepath.Join(dir, "gitconfig"),
			"GIT_CONFIG_GLOBAL=" + filepath.Join(dir, "empty"),
			"HOME=" + filepath.Join(dir, "empty-home"),
			"PATH=" + os.Getenv("PATH"),
		}
		return cmd.CombinedOutput()
	}
	for _, args := range [][]string{
		{"init", "-q"},
		// user.useConfigOnly=true, same as build-snapshot.sh's check_git_identity: without
		// it, a git whose config sets no name/email does not fail -- it falls back to an
		// identity auto-guessed from the passwd entry and hostname, and only refuses when
		// the guessed email is not fully qualified. On a host whose hostname resolves to an
		// FQDN (many CI runners), a broken baked gitconfig would still commit and this test
		// would pass on exactly the drift it exists to catch.
		{"-c", "user.useConfigOnly=true", "commit", "--allow-empty", "-m", "#415"},
	} {
		if out, err := run(args...); err != nil {
			t.Fatalf("git %v (with only the baked system gitconfig, no prior config): %v\n%s",
				args, err, out)
		}
	}
	// Assert WHICH identity committed, not merely that a commit happened: useConfigOnly
	// above makes an unconfigured git fail, and this makes a wrongly-configured one fail
	// too, so the test cannot pass on any identity other than the one the images bake.
	out, err := run("log", "-1", "--format=%an <%ae>")
	if err != nil {
		t.Fatalf("git log -1 after the no-prior-config commit: %v\n%s", err, out)
	}
	if got, want := strings.TrimSpace(string(out)), "MOCA sandbox <sandbox@moca.invalid>"; got != want {
		t.Fatalf("the first commit carried %q, want %q -- the baked gitconfig is not the "+
			"identity git actually used", got, want)
	}
}
