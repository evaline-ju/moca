package main

import (
	"regexp"
	"slices"
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
