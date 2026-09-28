package exec

import "strings"

// workerSettings are the worker's OWN configuration (cmd/worker/main.go reads them). A command never
// inherits them (MI1 §5 R6): SANDBOX_TOKEN is the relay credential, and the rest describe the
// worker, not the workload. Everything else in the container's environment — the image's ENV, which
// toolchains depend on — still reaches commands.
var workerSettings = map[string]bool{
	"SANDBOX_TOKEN": true,
	"RELAY_ADDR":    true,
	"SANDBOX_ID":    true,
	"SANDBOX_IMAGE": true,
	"SANDBOX_TRUST": true,
}

// workerSettingPrefixes cover per-sandbox token overrides and harness/MOCA settings, none of which a
// workload has any business reading.
var workerSettingPrefixes = []string{"SANDBOX_TOKEN_", "SH_", "MOCA_"}

func commandEnv(environ []string) []string {
	out := make([]string, 0, len(environ))
	for _, kv := range environ {
		name, _, _ := strings.Cut(kv, "=")
		if workerSettings[name] || hasAnyPrefix(name, workerSettingPrefixes) {
			continue
		}
		out = append(out, kv)
	}
	return out
}

func hasAnyPrefix(s string, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}
